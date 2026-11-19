/**
 * Etapa 15 — PENDING_REFERENCE: referência fora de ordem, gatilho imediato,
 * worker agendado com backoff, esgotamento (TTL/tentativas) e várias
 * instâncias disputando o mesmo lote. PostgreSQL real.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { PendingReferencePolicy } from '../../src/domain/wager-transaction/pending-reference-policy';
import { createOrm } from '../../src/infrastructure/persistence/mikro-orm.config';
import { pgClient, resetDatabase, testConfig } from '../support/database';
import { assertLedgerInvariants } from '../support/invariants';
import { K, brl, buildServices, wagerCommand } from '../support/services';

let orm: MikroORM;
let c: Client;
const ctx = { correlationId: 'corr-pending' };

beforeAll(async () => {
  orm = await resetDatabase();
  c = await pgClient();
});
afterEach(async () => {
  await assertLedgerInvariants(c);
});
afterAll(async () => {
  await c.end();
  await orm.close(true);
});

async function row(transactionId: string) {
  const r = await c.query<{
    status: string;
    failure_code: string | null;
    attempts: number;
    reference_transaction_id: string | null;
  }>(
    'SELECT status, failure_code, attempts, reference_transaction_id FROM wager_transactions WHERE id = $1',
    [transactionId],
  );
  return r.rows[0];
}

async function balance(walletId: string): Promise<string> {
  const r = await c.query<{ b: string }>('SELECT balance::text AS b FROM wallets WHERE id = $1', [
    walletId,
  ]);
  return r.rows[0]?.b ?? '';
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error('condição não atingida no prazo');
}

/** Torna todas as pendências vencidas agora (sem esperar o backoff real). */
const makeDue = () =>
  c.query(
    "UPDATE wager_transactions SET next_attempt_at = now() - interval '1 minute' WHERE status = 'PENDING_REFERENCE'",
  );

describe('Referência fora de ordem', () => {
  test('ROLLBACK antes da BET: 202, e processado imediatamente quando a BET chega', async () => {
    const s = buildServices(orm, 5000, undefined, { immediateDependents: true });
    const w = await s.createWallet.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('100.00') },
      ctx,
    );
    const betExt = `bet-${Bun.randomUUIDv7()}`;
    const rb = await s.submit.execute(
      wagerCommand(w, K.Rollback, '30.00', { referenceExternalTransactionId: betExt }),
      ctx,
    );
    expect<string>(rb.result.status).toBe('PENDING_REFERENCE');

    const bet = await s.submit.execute(
      wagerCommand(w, K.Bet, '30.00', { externalTransactionId: betExt }),
      ctx,
    );
    expect<string>(bet.result.status).toBe('PROCESSED');

    await waitFor(async () => (await row(rb.result.transactionId))?.status === 'PROCESSED');
    expect((await row(rb.result.transactionId))?.reference_transaction_id).toBe(
      bet.result.transactionId,
    );
    expect(await balance(w.id)).toBe('100.00');
    // Replay do ROLLBACK agora devolve o resultado final.
    const replay = await s.submit.execute(
      wagerCommand(w, K.Rollback, '30.00', {
        referenceExternalTransactionId: betExt,
        externalTransactionId:
          (
            await c.query<{ e: string }>(
              'SELECT external_transaction_id AS e FROM wager_transactions WHERE id = $1',
              [rb.result.transactionId],
            )
          ).rows[0]?.e ?? '',
      }),
      ctx,
    );
    expect<string>(replay.result.status).toBe('PROCESSED');
    expect(replay.result.idempotentReplay).toBe(true);
  });

  test('cadeia: ROLLBACK(REFUND) e REFUND(BET) antes da BET → tudo resolvido em cascata', async () => {
    const s = buildServices(orm, 5000, undefined, { immediateDependents: true });
    const w = await s.createWallet.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('100.00') },
      ctx,
    );
    const betExt = `bet-${Bun.randomUUIDv7()}`;
    const refundExt = `refund-${Bun.randomUUIDv7()}`;
    const rb = await s.submit.execute(
      wagerCommand(w, K.Rollback, '10.00', { referenceExternalTransactionId: refundExt }),
      ctx,
    );
    const refund = await s.submit.execute(
      wagerCommand(w, K.Refund, '10.00', {
        externalTransactionId: refundExt,
        referenceExternalTransactionId: betExt,
      }),
      ctx,
    );
    expect<string>(refund.result.status).toBe('PENDING_REFERENCE');
    await s.submit.execute(wagerCommand(w, K.Bet, '10.00', { externalTransactionId: betExt }), ctx);

    await waitFor(async () => (await row(rb.result.transactionId))?.status === 'PROCESSED');
    expect((await row(refund.result.transactionId))?.status).toBe('PROCESSED');
    // 100 - 10 (BET) + 10 (REFUND) - 10 (ROLLBACK do REFUND) = 90
    expect(await balance(w.id)).toBe('90.00');
  });

  test('referência chega REJECTED: dependente vira REFERENCE_NOT_PROCESSED (D2)', async () => {
    const s = buildServices(orm, 5000, undefined, { immediateDependents: true });
    const w = await s.createWallet.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('5.00') },
      ctx,
    );
    const betExt = `bet-${Bun.randomUUIDv7()}`;
    const refund = await s.submit.execute(
      wagerCommand(w, K.Refund, '50.00', { referenceExternalTransactionId: betExt }),
      ctx,
    );
    await s.submit.execute(wagerCommand(w, K.Bet, '50.00', { externalTransactionId: betExt }), ctx); // REJECTED
    await waitFor(async () => (await row(refund.result.transactionId))?.status === 'REJECTED');
    expect((await row(refund.result.transactionId))?.failure_code).toBe('REFERENCE_NOT_PROCESSED');
    expect(await balance(w.id)).toBe('5.00');
  });
});

describe('Worker agendado', () => {
  test('sem gatilho imediato, o worker resolve a pendência quando a referência existe', async () => {
    const s = buildServices(orm); // sem gatilho imediato
    const w = await s.createWallet.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('100.00') },
      ctx,
    );
    const betExt = `bet-${Bun.randomUUIDv7()}`;
    const rf = await s.submit.execute(
      wagerCommand(w, K.Refund, '20.00', { referenceExternalTransactionId: betExt }),
      ctx,
    );
    await s.submit.execute(wagerCommand(w, K.Bet, '20.00', { externalTransactionId: betExt }), ctx);
    expect((await row(rf.result.transactionId))?.status).toBe('PENDING_REFERENCE');

    await makeDue();
    expect(await s.pending.runDue(50)).toBeGreaterThanOrEqual(1);
    expect((await row(rf.result.transactionId))?.status).toBe('PROCESSED');
    expect(await balance(w.id)).toBe('100.00');
  });

  test('referência ainda ausente: reagenda com backoff e incrementa attempts', async () => {
    const s = buildServices(orm);
    const w = await s.createWallet.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('100.00') },
      ctx,
    );
    const rf = await s.submit.execute(
      wagerCommand(w, K.Refund, '1.00', { referenceExternalTransactionId: 'nunca' }),
      ctx,
    );
    await makeDue();
    await s.pending.runDue(50);
    const r = await row(rf.result.transactionId);
    expect(r?.status).toBe('PENDING_REFERENCE');
    expect(r?.attempts).toBe(1);
    const next = await c.query<{ s: string }>(
      'SELECT EXTRACT(EPOCH FROM (next_attempt_at - now()))::int::text AS s FROM wager_transactions WHERE id = $1',
      [rf.result.transactionId],
    );
    // Segunda tentativa: base 2 s × 2^1 = 4 s.
    expect(Number.parseInt(next.rows[0]?.s ?? '0', 10)).toBeGreaterThanOrEqual(2);
  });

  test('TTL esgotado: REJECTED REFERENCE_NOT_FOUND + evento WagerTransactionRejected', async () => {
    const shortTtl = new PendingReferencePolicy({
      ttlMs: 200,
      baseDelayMs: 10,
      maxDelayMs: 50,
      maxAttempts: 20,
    });
    const s = buildServices(orm, 5000, shortTtl);
    const w = await s.createWallet.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('100.00') },
      ctx,
    );
    const rf = await s.submit.execute(
      wagerCommand(w, K.Refund, '1.00', { referenceExternalTransactionId: 'nunca' }),
      ctx,
    );
    await Bun.sleep(250);
    await makeDue();
    await s.pending.runDue(50);
    const r = await row(rf.result.transactionId);
    expect(r?.status).toBe('REJECTED');
    expect(r?.failure_code).toBe('REFERENCE_NOT_FOUND');
    const ev = await c.query<{ t: string; code: string }>(
      "SELECT event_type AS t, payload->'data'->>'failureCode' AS code FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1 ORDER BY occurred_at",
      [rf.result.transactionId],
    );
    expect(ev.rows).toEqual([
      { t: 'WagerTransactionPendingReference', code: null as unknown as string },
      { t: 'WagerTransactionRejected', code: 'REFERENCE_NOT_FOUND' },
    ]);
  });

  test('limite de tentativas esgotado: REJECTED REFERENCE_NOT_FOUND', async () => {
    const few = new PendingReferencePolicy({
      ttlMs: 3_600_000,
      baseDelayMs: 1,
      maxDelayMs: 1,
      maxAttempts: 3,
    });
    const s = buildServices(orm, 5000, few);
    const w = await s.createWallet.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('100.00') },
      ctx,
    );
    const rf = await s.submit.execute(
      wagerCommand(w, K.Refund, '1.00', { referenceExternalTransactionId: 'nunca' }),
      ctx,
    );
    for (let i = 0; i < 3; i++) {
      await makeDue();
      await s.pending.runDue(50);
    }
    const r = await row(rf.result.transactionId);
    expect(r?.status).toBe('REJECTED');
    expect(r?.failure_code).toBe('REFERENCE_NOT_FOUND');
    expect(r?.attempts).toBe(2);
  });

  test('duas instâncias (ORMs distintos) disputando o mesmo lote: cada pendência resolvida 1×', async () => {
    const s1 = buildServices(orm);
    const orm2 = await createOrm(testConfig().database);
    try {
      const s2 = buildServices(orm2);
      const w = await s1.createWallet.execute(
        { playerId: Bun.randomUUIDv7(), initialBalance: brl('1000.00') },
        ctx,
      );
      const bets: string[] = [];
      for (let i = 0; i < 20; i++) {
        const ext = `bet-${Bun.randomUUIDv7()}`;
        bets.push(ext);
        await s1.submit.execute(
          wagerCommand(w, K.Refund, '1.00', { referenceExternalTransactionId: ext }),
          ctx,
        );
      }
      for (const ext of bets)
        await s1.submit.execute(
          wagerCommand(w, K.Bet, '1.00', { externalTransactionId: ext }),
          ctx,
        );
      await makeDue();
      const [a, b] = await Promise.all([s1.pending.runDue(7), s2.pending.runDue(7)]);
      expect(a + b).toBeLessThanOrEqual(14);
      for (let i = 0; i < 5; i++) {
        await makeDue();
        await Promise.all([s1.pending.runDue(7), s2.pending.runDue(7)]);
      }
      const pending = await c.query(
        "SELECT 1 FROM wager_transactions WHERE wallet_id = $1 AND status = 'PENDING_REFERENCE'",
        [w.id],
      );
      expect(pending.rowCount).toBe(0);
      // 20 BETs debitadas e 20 REFUNDs creditados: saldo intacto; um lançamento por transação.
      expect(await balance(w.id)).toBe('1000.00');
      const credits = await c.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id WHERE t.wallet_id = $1 AND t.kind = 'REFUND'",
        [w.id],
      );
      expect(credits.rows[0]?.n).toBe('20');
    } finally {
      await orm2.close(true);
    }
  });
});
