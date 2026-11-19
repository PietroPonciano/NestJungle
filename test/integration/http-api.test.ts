/**
 * Etapa 14 — um teste HTTP REAL por linha da tabela de status (guia §7.3),
 * mais as rotas de consulta. App Nest completa, PostgreSQL e LocalStack reais.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
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
  // lock_timeout curto para provocar o 503 de forma determinística.
  ({ app } = await createApp(
    testConfig({ WORKERS_ENABLED: 'false', DATABASE_LOCK_TIMEOUT_MS: '300', LOG_LEVEL: 'error' }),
  ));
  await app.listen(0);
  base = await app.getUrl();
  c = await pgClient();
});
afterEach(async () => {
  await assertLedgerInvariants(c);
});
afterAll(async () => {
  await c.end();
  await app.close();
});

interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res<T>> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T, headers: res.headers };
}

interface WalletBody {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

async function newWallet(amount = '100.00'): Promise<WalletBody> {
  const r = await call<WalletBody>('POST', '/wallets', {
    playerId: Bun.randomUUIDv7(),
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(r.status).toBe(201);
  return r.body;
}

function wager(w: WalletBody, over: Record<string, unknown> = {}) {
  const ext = `tx-${Bun.randomUUIDv7()}`;
  return {
    body: {
      providerId: 'provider-a',
      externalTransactionId: ext,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...over,
    },
    headers: { 'Idempotency-Key': `provider-a:${ext}` },
  };
}

const submit = (w: ReturnType<typeof wager>) =>
  call('POST', '/wagering/transactions', w.body, w.headers);

describe('POST /wallets', () => {
  test('201 criada (contrato do enunciado) com X-Correlation-Id', async () => {
    const playerId = Bun.randomUUIDv7();
    const r = await call<WalletBody>('POST', '/wallets', {
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      id: r.body.id,
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(r.headers.get('x-correlation-id')).toBeTruthy();
  });

  test('409 duplicada (player + moeda)', async () => {
    const w = await newWallet();
    const r = await call('POST', '/wallets', {
      playerId: w.playerId,
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('WALLET_ALREADY_EXISTS');
  });

  test('400 inválida: amount number, negativo, 3 casas, playerId não-UUID, JSON malformado', async () => {
    const bad = [
      { playerId: Bun.randomUUIDv7(), initialBalance: { amount: 10, currency: 'BRL' } },
      { playerId: Bun.randomUUIDv7(), initialBalance: { amount: '-1.00', currency: 'BRL' } },
      { playerId: Bun.randomUUIDv7(), initialBalance: { amount: '1.001', currency: 'BRL' } },
      { playerId: 'nao-uuid', initialBalance: { amount: '1.00', currency: 'BRL' } },
    ];
    for (const body of bad) {
      const r = await call('POST', '/wallets', body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('INVALID_PAYLOAD');
    }
    expect((await call('POST', '/wallets', '{"playerId":')).status).toBe(400);
  });
});

describe('POST /wagering/transactions — tabela de status §7.3', () => {
  test('201 processada (primeira vez)', async () => {
    const w = await newWallet('1000.00');
    const r = await submit(wager(w));
    expect(r.status).toBe(201);
    expect(r.body).toEqual({
      transactionId: r.body.transactionId,
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  test('200 replay idêntico de transação processada, com idempotentReplay true', async () => {
    const w = await newWallet('1000.00');
    const req = wager(w);
    const first = await submit(req);
    const replay = await submit(req);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('202 PENDING_REFERENCE (referência ausente) com saldo atual', async () => {
    const w = await newWallet('100.00');
    const r = await submit(
      wager(w, { kind: 'REFUND', referenceExternalTransactionId: 'bet-futura' }),
    );
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
    });
    const replay = await submit(
      wager(w, { kind: 'REFUND', referenceExternalTransactionId: 'bet-futura' }),
    );
    expect(replay.status).toBe(202);
  });

  test('422 rejeição de negócio com failureCode; replay = o mesmo 422 com idempotentReplay', async () => {
    const w = await newWallet('20.00');
    const req = wager(w, { money: { amount: '80.00', currency: 'BRL' } });
    const r = await submit(req);
    expect(r.status).toBe(422);
    expect(r.body).toEqual({
      transactionId: r.body.transactionId,
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '20.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const replay = await submit(req);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...r.body, idempotentReplay: true });
  });

  test('400 payload inválido e header ausente', async () => {
    const w = await newWallet();
    const req = wager(w);
    const noHeader = await call('POST', '/wagering/transactions', req.body);
    expect(noHeader.status).toBe(400);
    expect(noHeader.body.error).toBe('INVALID_PAYLOAD');
    for (const over of [
      { money: { amount: 25, currency: 'BRL' } },
      { money: '25.00' },
      { kind: 'OPENING' },
      { kind: 'REFUND' }, // sem referência
      { walletId: 'x' },
      { roundId: '' },
    ]) {
      const r = await submit(wager(w, over));
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('INVALID_PAYLOAD');
    }
  });

  test('409 mesma key com payload diferente; 409 mesmo externalTransactionId com key diferente', async () => {
    const w = await newWallet();
    const req = wager(w);
    await submit(req);
    const divergent = await call(
      'POST',
      '/wagering/transactions',
      { ...req.body, money: { amount: '26.00', currency: 'BRL' } },
      req.headers,
    );
    expect(divergent.status).toBe(409);
    expect(divergent.body.error).toBe('IDEMPOTENCY_CONFLICT');
    const otherKey = await call('POST', '/wagering/transactions', req.body, {
      'Idempotency-Key': 'outra',
    });
    expect(otherKey.status).toBe(409);

    // Mesma key reaproveitada com uma wallet inexistente: conflito, não 404.
    const ghostWallet = await call(
      'POST',
      '/wagering/transactions',
      { ...req.body, walletId: Bun.randomUUIDv7() },
      req.headers,
    );
    expect(ghostWallet.status).toBe(409);
    expect(ghostWallet.body.error).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('400 idempotencyKey do corpo diferente do header; igual ao header é aceita', async () => {
    const w = await newWallet();
    const req = wager(w);
    const mismatch = await call(
      'POST',
      '/wagering/transactions',
      { ...req.body, idempotencyKey: 'outra-chave' },
      req.headers,
    );
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe('INVALID_PAYLOAD');
    const same = await call(
      'POST',
      '/wagering/transactions',
      { ...req.body, idempotencyKey: req.headers['Idempotency-Key'] },
      req.headers,
    );
    expect(same.status).toBe(201);
  });

  test('404 wallet inexistente', async () => {
    const ghost = {
      id: Bun.randomUUIDv7(),
      playerId: Bun.randomUUIDv7(),
      balance: { amount: '0', currency: 'BRL' },
      version: 1,
    };
    const r = await submit(wager(ghost));
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('WALLET_NOT_FOUND');
  });

  test('500 falha permanente inesperada (FAILED auditável)', async () => {
    const w = await newWallet('1000.00');
    await c.query(`
      CREATE OR REPLACE FUNCTION test_fail_ledger() RETURNS trigger AS $$
      BEGIN IF NEW.amount = 666.66 THEN RAISE EXCEPTION 'falha permanente simulada'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_ledger BEFORE INSERT ON wallet_ledger_entries FOR EACH ROW EXECUTE FUNCTION test_fail_ledger();`);
    try {
      const r = await submit(wager(w, { money: { amount: '666.66', currency: 'BRL' } }));
      expect(r.status).toBe(500);
      expect(r.body).toMatchObject({ status: 'FAILED', failureCode: 'INTERNAL_PERMANENT_ERROR' });
    } finally {
      await c.query(
        'DROP TRIGGER test_fail_ledger ON wallet_ledger_entries; DROP FUNCTION test_fail_ledger();',
      );
    }
  });

  test('503 falha transitória (lock da wallet além do lock_timeout) com Retry-After; reenvio com a mesma key funciona', async () => {
    const w = await newWallet('100.00');
    const req = wager(w);
    const holder = await pgClient();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [w.id]);
    let r: Res;
    try {
      r = await submit(req);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('1');
    expect(r.body.error).toBe('TRANSIENT_INFRASTRUCTURE_ERROR');
    // Nada foi persistido (D7); o reenvio é a primeira aplicação.
    const retry = await submit(req);
    expect(retry.status).toBe(201);
  });
});

describe('Consultas', () => {
  test('GET /wallets/:id (200, 404, 400)', async () => {
    const w = await newWallet('10.00');
    const ok = await call<WalletBody>('GET', `/wallets/${w.id}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual(w);
    expect((await call('GET', `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await call('GET', '/wallets/abc')).status).toBe(400);
  });

  test('GET /wallets/:id/ledger: cursor opaco e estável, sem repetição nem buraco', async () => {
    const w = await newWallet('100.00');
    for (let i = 0; i < 5; i++)
      await submit(wager(w, { money: { amount: '1.00', currency: 'BRL' } }));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const r = await call<{
        entries: { id: string; balanceAfter: { amount: string } }[];
        nextCursor: string | null;
      }>('GET', `/wallets/${w.id}/ledger${q}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.entries.map((e) => e.id));
      cursor = r.body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen).toHaveLength(6); // OPENING + 5 BETs
    expect(new Set(seen).size).toBe(6);
    expect(pages).toBe(3);
    expect((await call('GET', `/wallets/${w.id}/ledger?cursor=lixo`)).status).toBe(400);
    expect((await call('GET', `/wallets/${w.id}/ledger?limit=0`)).status).toBe(400);
  });

  test('GET /wagering/transactions/:id e /providers/:p/wagering/transactions/:ext', async () => {
    const w = await newWallet('100.00');
    const req = wager(w);
    const created = await submit(req);
    const byId = await call('GET', `/wagering/transactions/${String(created.body.transactionId)}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: created.body.transactionId,
      status: 'PROCESSED',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      observedBalance: { amount: '75.00', currency: 'BRL' },
    });
    const byExt = await call(
      'GET',
      `/providers/provider-a/wagering/transactions/${req.body.externalTransactionId}`,
    );
    expect(byExt.status).toBe(200);
    expect(byExt.body.transactionId).toBe(created.body.transactionId);
    expect((await call('GET', `/wagering/transactions/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect(
      (await call('GET', '/providers/provider-a/wagering/transactions/nao-existe')).status,
    ).toBe(404);
  });
});
