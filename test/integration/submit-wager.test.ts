/**
 * Etapa 11 — SubmitWagerTransactionUseCase sobre PostgreSQL real.
 * Toda a suíte termina conferindo a invariante saldo == ledger.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import {
  IdempotencyConflictError,
  InboxConflictError,
  InvalidPayloadError,
  WalletNotFoundError,
} from '../../src/application/errors';
import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/wager-transaction/failure-code';
import { WagerTransactionStatus as S } from '../../src/domain/wager-transaction/wager-transaction-kind';
import { pgClient, resetDatabase } from '../support/database';
import { assertLedgerInvariants } from '../support/invariants';
import { K, brl, buildServices, wagerCommand } from '../support/services';

let orm: MikroORM;
let c: Client;
let s: ReturnType<typeof buildServices>;
const ctx = { correlationId: 'corr-test' };

beforeAll(async () => {
  orm = await resetDatabase();
  c = await pgClient();
  s = buildServices(orm);
});
afterEach(async () => {
  await assertLedgerInvariants(c);
});
afterAll(async () => {
  await c.end();
  await orm.close(true);
});

const wallet = (initial: string) =>
  s.createWallet.execute({ playerId: Bun.randomUUIDv7(), initialBalance: brl(initial) }, ctx);

async function rejects(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('esperava erro');
}

async function ledgerCount(walletId: string, direction?: string): Promise<number> {
  const r = await c.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = $1 ${direction ? 'AND direction = $2' : ''}`,
    direction ? [walletId, direction] : [walletId],
  );
  return Number.parseInt(r.rows[0]?.n ?? '0', 10);
}

describe('Fluxo básico', () => {
  test('BET processada: PROCESSED, saldo, 1 DEBIT, eventos Processed + BalanceChanged', async () => {
    const w = await wallet('1000.00');
    const cmd = wagerCommand(w, K.Bet, '25.00');
    const { result } = await s.submit.execute(cmd, ctx);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      transactionId: result.transactionId,
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
    const ev = await c.query<{ event_type: string }>(
      "SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1 ORDER BY event_type",
      [result.transactionId],
    );
    expect(ev.rows.map((r) => r.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('replay idêntico: mesmo resultado original, idempotentReplay true, sem novo débito', async () => {
    const w = await wallet('100.00');
    const cmd = wagerCommand(w, K.Bet, '30.00');
    const first = await s.submit.execute(cmd, ctx);
    // Outra operação muda o saldo; o replay ainda devolve o saldo observado na época.
    await s.submit.execute(wagerCommand(w, K.Win, '50.00'), ctx);
    const replay = await s.submit.execute(cmd, ctx);
    expect(replay.result).toEqual({ ...first.result, idempotentReplay: true });
    expect(replay.result.balance.amount).toBe('70.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
  });

  test('mesma key com payload diferente: 409 (conflito, não replay)', async () => {
    const w = await wallet('100.00');
    const cmd = wagerCommand(w, K.Bet, '10.00');
    await s.submit.execute(cmd, ctx);
    const err = await rejects(s.submit.execute({ ...cmd, money: brl('11.00') }, ctx));
    expect(err).toBeInstanceOf(IdempotencyConflictError);
  });

  test('mesmo externalTransactionId com key diferente: 409 (D5)', async () => {
    const w = await wallet('100.00');
    const cmd = wagerCommand(w, K.Bet, '10.00');
    await s.submit.execute(cmd, ctx);
    const err = await rejects(s.submit.execute({ ...cmd, idempotencyKey: 'outra-key' }, ctx));
    expect(err).toBeInstanceOf(IdempotencyConflictError);
  });

  test('saldo insuficiente: REJECTED INSUFFICIENT_FUNDS (422), auditável, sem lançamento', async () => {
    const w = await wallet('10.00');
    const cmd = wagerCommand(w, K.Bet, '80.00');
    const { result } = await s.submit.execute(cmd, ctx);
    expect<string | undefined>(result.status).toBe('REJECTED');
    expect<string | undefined>(result.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(result.balance.amount).toBe('10.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(0);
    // Replay de rejeitada: mesmo 422 com idempotentReplay
    const replay = await s.submit.execute(cmd, ctx);
    expect(replay.result).toEqual({ ...result, idempotentReplay: true });
  });

  test('LOSS: PROCESSED sem mover saldo, sem lançamento, sem WalletBalanceChanged', async () => {
    const w = await wallet('100.00');
    const { result } = await s.submit.execute(wagerCommand(w, K.Loss, '0.00'), ctx);
    expect<string | undefined>(result.status).toBe('PROCESSED');
    expect(result.balance.amount).toBe('100.00');
    expect(await ledgerCount(w.id)).toBe(1); // só o OPENING
    const ev = await c.query<{ event_type: string }>(
      "SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1",
      [result.transactionId],
    );
    expect(ev.rows.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed']);
  });

  test('referência ausente: PENDING_REFERENCE (202) com saldo atual e evento PendingReference', async () => {
    const w = await wallet('100.00');
    const { result } = await s.submit.execute(
      wagerCommand(w, K.Refund, '10.00', { referenceExternalTransactionId: 'bet-que-nao-chegou' }),
      ctx,
    );
    expect<string | undefined>(result.status).toBe('PENDING_REFERENCE');
    expect(result.balance.amount).toBe('100.00');
    const row = await c.query<{ next_attempt_at: Date | null; expires_at: Date | null }>(
      'SELECT next_attempt_at, expires_at FROM wager_transactions WHERE id = $1',
      [result.transactionId],
    );
    expect(row.rows[0]?.next_attempt_at).not.toBeNull();
    expect(row.rows[0]?.expires_at).not.toBeNull();
    const ev = await c.query<{ event_type: string }>(
      "SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = $1",
      [result.transactionId],
    );
    expect(ev.rows.map((r) => r.event_type)).toEqual(['WagerTransactionPendingReference']);
  });

  test('REFUND de BET processada credita; segundo REFUND/ROLLBACK da mesma BET: ALREADY_REVERSED (D1)', async () => {
    const w = await wallet('100.00');
    const bet = wagerCommand(w, K.Bet, '40.00');
    await s.submit.execute(bet, ctx);
    const ref = { referenceExternalTransactionId: bet.externalTransactionId };
    const refund = await s.submit.execute(wagerCommand(w, K.Refund, '40.00', ref), ctx);
    expect(refund.result.balance.amount).toBe('100.00');
    const rollback = await s.submit.execute(wagerCommand(w, K.Rollback, '40.00', ref), ctx);
    expect(rollback.result.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(rollback.result.balance.amount).toBe('100.00');
  });

  test('wallet inexistente: WalletNotFoundError (404), nenhuma linha gravada (D7)', async () => {
    const cmd = wagerCommand(
      { id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() },
      K.Bet,
      '1.00',
    );
    expect(await rejects(s.submit.execute(cmd, ctx))).toBeInstanceOf(WalletNotFoundError);
    const r = await c.query('SELECT 1 FROM wager_transactions WHERE external_transaction_id = $1', [
      cmd.externalTransactionId,
    ]);
    expect(r.rowCount).toBe(0);
  });

  test('payload inválido de domínio (REFUND sem referência, BET 0): InvalidPayloadError (400)', async () => {
    const w = await wallet('10.00');
    expect(await rejects(s.submit.execute(wagerCommand(w, K.Refund, '1.00'), ctx))).toBeInstanceOf(
      InvalidPayloadError,
    );
    expect(await rejects(s.submit.execute(wagerCommand(w, K.Bet, '0.00'), ctx))).toBeInstanceOf(
      InvalidPayloadError,
    );
    expect(await rejects(s.submit.execute(wagerCommand(w, K.Opening, '1.00'), ctx))).toBeInstanceOf(
      InvalidPayloadError,
    );
  });

  test('moeda diferente da wallet: REJECTED CURRENCY_MISMATCH', async () => {
    const w = await wallet('10.00');
    const { result } = await s.submit.execute(
      wagerCommand(w, K.Bet, '1.00', { money: Money.from({ amount: '1.00', currency: 'USD' }) }),
      ctx,
    );
    expect<string | undefined>(result.failureCode).toBe('CURRENCY_MISMATCH');
  });
});

describe('Inbox (entrada SQS)', () => {
  const inbox = (messageId: string, payloadHash = 'h-1') => ({
    consumerName: 'test-consumer',
    messageId,
    payloadHash,
  });

  test('redelivery da mesma mensagem: inbox absorve, replay sem duplicar efeito', async () => {
    const w = await wallet('100.00');
    const cmd = wagerCommand(w, K.Bet, '10.00');
    const first = await s.submit.execute(cmd, ctx, inbox('m-1'));
    expect(first.duplicateMessage).toBe(false);
    const again = await s.submit.execute(cmd, ctx, inbox('m-1'));
    expect(again.duplicateMessage).toBe(true);
    expect(again.result.idempotentReplay).toBe(true);
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
    const r = await c.query<{ processed_at: Date | null }>(
      'SELECT processed_at FROM inbox_messages WHERE message_id = $1',
      ['m-1'],
    );
    expect(r.rows[0]?.processed_at).not.toBeNull();
  });

  test('mesmo messageId com payload diferente: InboxConflictError', async () => {
    const w = await wallet('100.00');
    await s.submit.execute(wagerCommand(w, K.Bet, '10.00'), ctx, inbox('m-2', 'h-a'));
    const err = await rejects(
      s.submit.execute(wagerCommand(w, K.Bet, '20.00'), ctx, inbox('m-2', 'h-b')),
    );
    expect(err).toBeInstanceOf(InboxConflictError);
  });

  test('mesma operação com messageIds diferentes (Restrição #3): banco garante 1 efeito', async () => {
    const w = await wallet('100.00');
    const cmd = wagerCommand(w, K.Bet, '10.00');
    await s.submit.execute(cmd, ctx, inbox('m-3a'));
    const second = await s.submit.execute(cmd, ctx, inbox('m-3b'));
    expect(second.result.idempotentReplay).toBe(true);
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
  });
});

describe('Concorrência (paralelismo real no PostgreSQL)', () => {
  test('100.00 + 2×BET 80.00 simultâneas: 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 débito', async () => {
    const w = await wallet('100.00');
    const outcomes = await Promise.all([
      s.submit.execute(wagerCommand(w, K.Bet, '80.00'), ctx),
      s.submit.execute(wagerCommand(w, K.Bet, '80.00'), ctx),
    ]);
    const statuses = outcomes.map((o): string => o.result.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect<string | undefined>(
      outcomes.find((o) => o.result.status === S.Rejected)?.result.failureCode,
    ).toBe('INSUFFICIENT_FUNDS');
    const bal = await c.query<{ balance: string }>(
      'SELECT balance::text AS balance FROM wallets WHERE id = $1',
      [w.id],
    );
    expect(bal.rows[0]?.balance).toBe('20.00');
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
  });

  test('mesma aposta 50× em paralelo: 1 débito, 49 replays', async () => {
    const w = await wallet('100.00');
    const cmd = wagerCommand(w, K.Bet, '10.00');
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => s.submit.execute(cmd, ctx)),
    );
    expect(outcomes.filter((o) => !o.result.idempotentReplay)).toHaveLength(1);
    expect(outcomes.filter((o) => o.result.idempotentReplay)).toHaveLength(49);
    expect(new Set(outcomes.map((o) => o.result.transactionId)).size).toBe(1);
    expect(new Set(outcomes.map((o) => o.result.balance.amount))).toEqual(new Set(['90.00']));
    expect(await ledgerCount(w.id, 'DEBIT')).toBe(1);
  });

  test('mesma key em paralelo com walletIds diferentes (locks diferentes): 1 grava, o outro 409', async () => {
    const a = await wallet('100.00');
    const b = await wallet('100.00');
    const cmdA = wagerCommand(a, K.Bet, '10.00', {
      externalTransactionId: `race-${Bun.randomUUIDv7()}`,
    });
    const cmdB = { ...cmdA, walletId: b.id, playerId: b.playerId };
    const results = await Promise.allSettled([
      s.submit.execute(cmdA, ctx),
      s.submit.execute(cmdB, ctx),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed?.reason).toBeInstanceOf(IdempotencyConflictError);
  });

  test('hot wallet: 30 BETs distintas de 5.00 sobre 100.00 → 20 PROCESSED, 10 REJECTED, saldo 0.00', async () => {
    const w = await wallet('100.00');
    const outcomes = await Promise.all(
      Array.from({ length: 30 }, () => s.submit.execute(wagerCommand(w, K.Bet, '5.00'), ctx)),
    );
    expect(outcomes.filter((o) => o.result.status === S.Processed)).toHaveLength(20);
    expect(outcomes.filter((o) => o.result.status === S.Rejected)).toHaveLength(10);
    const bal = await c.query<{ balance: string }>(
      'SELECT balance::text AS balance FROM wallets WHERE id = $1',
      [w.id],
    );
    expect(bal.rows[0]?.balance).toBe('0.00');
  });
});

describe('Falha permanente inesperada', () => {
  test('erro inesperado no banco: rollback do efeito e FAILED INTERNAL_PERMANENT_ERROR auditável', async () => {
    const w = await wallet('1000.00');
    // Falha permanente REAL no PostgreSQL: trigger de teste que recusa um valor específico.
    await c.query(`
      CREATE OR REPLACE FUNCTION test_fail_ledger() RETURNS trigger AS $$
      BEGIN IF NEW.amount = 666.66 THEN RAISE EXCEPTION 'falha permanente simulada'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_ledger BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_ledger();`);
    try {
      const cmd = wagerCommand(w, K.Bet, '666.66');
      const { result } = await s.submit.execute(cmd, ctx);
      expect<string | undefined>(result.status).toBe('FAILED');
      expect<string | undefined>(result.failureCode).toBe('INTERNAL_PERMANENT_ERROR');
      expect(result.balance.amount).toBe('1000.00');
      const row = await c.query<{ status: string; failure_code: string }>(
        'SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = $1',
        [cmd.externalTransactionId],
      );
      expect(row.rows).toEqual([{ status: 'FAILED', failure_code: 'INTERNAL_PERMANENT_ERROR' }]);
      expect(await ledgerCount(w.id, 'DEBIT')).toBe(0);
      // Replay de FAILED devolve o mesmo resultado (E5)
      const replay = await s.submit.execute(cmd, ctx);
      expect(replay.result).toEqual({ ...result, idempotentReplay: true });
    } finally {
      await c.query(
        'DROP TRIGGER test_fail_ledger ON wallet_ledger_entries; DROP FUNCTION test_fail_ledger();',
      );
    }
  });
});
