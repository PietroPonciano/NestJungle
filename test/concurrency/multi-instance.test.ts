/**
 * Etapa 18 — concorrência com 3 INSTÂNCIAS REAIS (processos via Bun.spawn),
 * mesmo PostgreSQL e mesmas filas (LocalStack). Cenários do guia §11.3:
 *   1. mesma aposta 50× em paralelo
 *   2. 100.00 + 2×BET 80.00 simultâneas (em instâncias diferentes)
 *   3. wallets distintas em paralelo, sem bloqueio cruzado
 *   4. ≥ 3 instâncias consumindo a fila + HTTP ao mesmo tempo
 *   6. publishers concorrentes sobre a mesma outbox (cada instância tem um)
 *   7. ROLLBACK entregue (instância A) antes da BET (instância B)
 * Invariante final em todos: saldo == ledger, sem duplicata, sem negativo.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { Client } from 'pg';
import { pgClient, resetDatabase } from '../support/database';
import {
  type Instance,
  createWallet,
  http,
  messageBody,
  startInstance,
  submitVia,
  waitFor,
  wagerBody,
} from '../support/instances';
import { assertLedgerInvariants } from '../support/invariants';
import { collect, drain, queueDepth, testSqs } from '../support/sqs';

let instances: Instance[] = [];
let c: Client;
let sqs: SQSClient;
let cfg: ReturnType<typeof testSqs>['config'];

beforeAll(async () => {
  await (await resetDatabase()).close(true);
  c = await pgClient();
  ({ client: sqs, config: cfg } = testSqs());
  await drain(sqs, cfg.transactionsQueueUrl);
  await drain(sqs, cfg.transactionsDlqUrl);
  await drain(sqs, cfg.eventsQueueUrl);
  instances = await Promise.all(['A', 'B', 'C'].map((n) => startInstance(n)));
});
afterEach(async () => {
  await assertLedgerInvariants(c);
});
afterAll(async () => {
  await Promise.all(instances.map((i) => i.kill('SIGTERM')));
  await c.end();
  sqs.destroy();
});

const pick = (i: number): Instance => instances[i % instances.length] as Instance;

async function balance(walletId: string): Promise<string> {
  const r = await c.query<{ b: string }>('SELECT balance::text AS b FROM wallets WHERE id = $1', [
    walletId,
  ]);
  return r.rows[0]?.b ?? '';
}

async function debits(walletId: string): Promise<number> {
  const r = await c.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'",
    [walletId],
  );
  return Number.parseInt(r.rows[0]?.n ?? '0', 10);
}

describe('Múltiplas instâncias reais', () => {
  test('1. mesma aposta 50× em paralelo, espalhada nas 3 instâncias: 1 débito, 49 replays', async () => {
    const w = await createWallet(pick(0), '100.00');
    const bet = wagerBody(w, 'BET', '10.00');
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => submitVia(pick(i), bet)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    expect(results.every((r) => r.body.idempotentReplay === (r.status === 200))).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await debits(w.id)).toBe(1);
    expect(await balance(w.id)).toBe('90.00');
  });

  test('2. 100.00 + 2×BET 80.00 simultâneas em instâncias diferentes: 1×201, 1×422, saldo 20.00, 1 débito', async () => {
    const w = await createWallet(pick(0), '100.00');
    const [r1, r2] = await Promise.all([
      submitVia(pick(1), wagerBody(w, 'BET', '80.00')),
      submitVia(pick(2), wagerBody(w, 'BET', '80.00')),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 422]);
    const rejected = [r1, r2].find((r) => r.status === 422);
    expect(rejected?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await balance(w.id)).toBe('20.00');
    expect(await debits(w.id)).toBe(1);
  });

  test('3. wallets distintas em paralelo: sem interferência e sem bloqueio cruzado', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createWallet(pick(i), '100.00')),
    );
    // Wallet bloqueada por outra conexão durante todo o cenário.
    const blocked = await createWallet(pick(0), '100.00');
    const holder = await pgClient();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [blocked.id]);
    try {
      const started = performance.now();
      const results = await Promise.all(
        wallets.flatMap((w, wi) =>
          Array.from({ length: 10 }, (_, j) =>
            submitVia(pick(wi + j), wagerBody(w, 'BET', '1.00')),
          ),
        ),
      );
      const elapsed = performance.now() - started;
      expect(results.every((r) => r.status === 201)).toBe(true);
      // 100 operações em outras wallets concluem mesmo com uma wallet travada:
      // o lock é por linha, não global (Restrição #6).
      expect(elapsed).toBeLessThan(10_000);
      for (const w of wallets) expect(await balance(w.id)).toBe('90.00');
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });

  test('4. 3 instâncias consumindo a fila + HTTP simultâneo: cada operação aplicada 1×', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createWallet(pick(i), '1000.00')),
    );
    const sqsOps: ReturnType<typeof wagerBody>[] = [];
    const sends: Promise<unknown>[] = [];
    for (const [wi, w] of wallets.entries()) {
      for (let k = 0; k < 8; k++) {
        const kind = k % 4 === 3 ? 'LOSS' : k % 4 === 2 ? 'WIN' : 'BET';
        const op = wagerBody(w, kind, kind === 'LOSS' ? '0.00' : `${String(wi + k + 1)}.00`);
        sqsOps.push(op);
        const body = JSON.stringify(messageBody(op));
        // Duplicata com dedup id diferente: o SQS entrega as duas (Restrição #3).
        for (const copy of k % 3 === 0 ? ['a', 'b'] : ['a']) {
          sends.push(
            sqs.send(
              new SendMessageCommand({
                QueueUrl: cfg.transactionsQueueUrl,
                MessageBody: body,
                MessageGroupId: w.id,
                MessageDeduplicationId: `${op.externalTransactionId}-${copy}`,
              }),
            ),
          );
        }
      }
    }
    await Promise.all(sends);
    // HTTP ao mesmo tempo nas mesmas wallets.
    const httpOps = wallets.flatMap((w, wi) =>
      Array.from({ length: 5 }, (_, j) => submitVia(pick(wi + j), wagerBody(w, 'BET', '2.00'))),
    );
    const httpResults = await Promise.all(httpOps);
    expect(httpResults.every((r) => r.status === 201)).toBe(true);

    await waitFor(
      async () => (await queueDepth(sqs, cfg.transactionsQueueUrl)) === 0,
      60_000,
      'fila vazia',
    );
    const ext = sqsOps.map((o) => o.externalTransactionId);
    const rows = await c.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM wager_transactions WHERE external_transaction_id = ANY($1)',
      [ext],
    );
    expect(rows.rows[0]?.n).toBe(String(ext.length)); // cada operação exatamente 1×
    expect(await queueDepth(sqs, cfg.transactionsDlqUrl)).toBe(0);
    const consumers = instances.filter((i) =>
      i.logs.some((l) => l.includes('"msg":"mensagem processada"')),
    );
    console.info(
      `[cenário 4] instâncias que consumiram mensagens: ${consumers.map((i) => i.name).join(', ')}`,
    );
  });

  test('7. ROLLBACK na instância A antes da BET na instância B: 202 e depois PROCESSED', async () => {
    const w = await createWallet(pick(0), '100.00');
    const betExt = `bet-${Bun.randomUUIDv7()}`;
    const rb = await submitVia(
      pick(0),
      wagerBody(w, 'ROLLBACK', '30.00', { referenceExternalTransactionId: betExt }),
    );
    expect(rb.status).toBe(202);
    const bet = await submitVia(
      pick(1),
      wagerBody(w, 'BET', '30.00', { externalTransactionId: betExt }),
    );
    expect(bet.status).toBe(201);
    await waitFor(
      async () => {
        const r = await http(
          pick(2),
          'GET',
          `/wagering/transactions/${String(rb.body.transactionId)}`,
        );
        return r.body.status === 'PROCESSED';
      },
      15_000,
      'ROLLBACK processado',
    );
    expect(await balance(w.id)).toBe('100.00');
  });

  test('6. publishers concorrentes (3 instâncias) sobre a mesma outbox: todos publicados, nenhum perdido ou duplicado', async () => {
    await waitFor(
      async () => {
        const r = await c.query<{ n: string }>(
          'SELECT COUNT(*)::text AS n FROM outbox_messages WHERE published_at IS NULL',
        );
        return r.rows[0]?.n === '0';
      },
      60_000,
      'outbox drenada',
    );
    const ids = (await c.query<{ id: string }>('SELECT id FROM outbox_messages')).rows.map(
      (r) => r.id,
    );
    const messages = await collect(sqs, cfg.eventsQueueUrl, ids.length, 30_000);
    const published = messages.map(
      (m) => (JSON.parse(m.Body ?? '{}') as { eventId: string }).eventId,
    );
    expect(new Set(published).size).toBe(published.length); // nenhum duplicado entregue
    expect(new Set(published)).toEqual(new Set(ids)); // nenhum perdido
    const publishers = instances.filter((i) =>
      i.logs.some((l) => l.includes('"msg":"evento publicado"')),
    );
    console.info(
      `[cenário 6] ${String(ids.length)} eventos; instâncias que publicaram: ${publishers.map((i) => i.name).join(', ')}`,
    );
  });
});
