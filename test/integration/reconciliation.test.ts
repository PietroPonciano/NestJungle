/**
 * Etapa 16 — reconciliação via HTTP real: consistente após operações e
 * divergência FORÇADA no banco sinalizada (consistent=false + métrica), sem
 * autocorreção.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { Client } from 'pg';
import { createApp } from '../../src/bootstrap';
import { pgClient, resetDatabase, testConfig } from '../support/database';
import { assertLedgerInvariants } from '../support/invariants';

let app: INestApplication;
let base: string;
let c: Client;

beforeAll(async () => {
  await (await resetDatabase()).close(true);
  ({ app } = await createApp(testConfig({ WORKERS_ENABLED: 'false', LOG_LEVEL: 'error' })));
  await app.listen(0);
  base = await app.getUrl();
  c = await pgClient();
});
afterAll(async () => {
  await c.end();
  await app.close();
});

async function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function divergenceMetric(): Promise<number> {
  const text = await (await fetch(`${base}/metrics`)).text();
  const line = text.split('\n').find((l) => l.startsWith('reconciliation_divergence_total '));
  return Number.parseInt(line?.split(' ')[1] ?? '0', 10);
}

describe('POST /wallets/:walletId/reconciliation', () => {
  test('consistente depois de operações (contrato do enunciado)', async () => {
    const playerId = Bun.randomUUIDv7();
    const w = await post('/wallets', {
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    const walletId = String(w.body.id);
    for (const [kind, amount] of [
      ['BET', '25.00'],
      ['WIN', '10.00'],
      ['LOSS', '0.00'],
      ['BET', '5000.00'],
    ] as const) {
      const ext = `tx-${Bun.randomUUIDv7()}`;
      await post(
        '/wagering/transactions',
        {
          providerId: 'p',
          externalTransactionId: ext,
          playerId,
          walletId,
          roundId: 'r',
          gameId: 'g',
          kind,
          money: { amount, currency: 'BRL' },
        },
        { 'Idempotency-Key': ext },
      );
    }
    const r = await post(`/wallets/${walletId}/reconciliation`);
    expect(r.status).toBe(200);
    // OPENING + BET + WIN = 3 lançamentos (LOSS e a BET rejeitada não lançam).
    expect(r.body).toEqual({
      walletId,
      storedBalance: { amount: '985.00', currency: 'BRL' },
      calculatedBalance: { amount: '985.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
    await assertLedgerInvariants(c);
  });

  test('divergência forçada: consistent=false, métrica incrementada e NADA é corrigido', async () => {
    const w = await post('/wallets', {
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    const walletId = String(w.body.id);
    const before = await divergenceMetric();
    // Corrupção proposital do saldo materializado (o ledger é imutável, a wallet não).
    await c.query('UPDATE wallets SET balance = 150.00 WHERE id = $1', [walletId]);
    try {
      const r = await post(`/wallets/${walletId}/reconciliation`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        storedBalance: { amount: '150.00', currency: 'BRL' },
        calculatedBalance: { amount: '100.00', currency: 'BRL' },
        difference: { amount: '50.00', currency: 'BRL' },
        consistent: false,
        checkedEntries: 1,
      });
      expect(await divergenceMetric()).toBe(before + 1);
      const still = await c.query<{ b: string }>(
        'SELECT balance::text AS b FROM wallets WHERE id = $1',
        [walletId],
      );
      expect(still.rows[0]?.b).toBe('150.00'); // não autocorrigiu
    } finally {
      await c.query('UPDATE wallets SET balance = 100.00 WHERE id = $1', [walletId]);
    }
    await assertLedgerInvariants(c);
  });

  test('wallet inexistente: 404; id inválido: 400', async () => {
    expect((await post(`/wallets/${Bun.randomUUIDv7()}/reconciliation`)).status).toBe(404);
    expect((await post('/wallets/xyz/reconciliation')).status).toBe(400);
  });
});
