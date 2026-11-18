/**
 * Etapa 17 — atomicidade entre wallet, ledger, inbox, transação e outbox
 * (enunciado §11: tudo ou nada). A falha é REAL, no PostgreSQL: um trigger de
 * teste recusa a escrita da outbox, a ÚLTIMA da transação. Tudo o que veio antes
 * (débito da wallet, lançamento, inbox) precisa sumir junto.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { pgClient, resetDatabase } from '../support/database';
import { assertLedgerInvariants } from '../support/invariants';
import { K, brl, buildServices, wagerCommand } from '../support/services';

let orm: MikroORM;
let c: Client;
let s: ReturnType<typeof buildServices>;
const ctx = { correlationId: 'corr-atomic' };

beforeAll(async () => {
  orm = await resetDatabase();
  c = await pgClient();
  s = buildServices(orm);
  await c.query(`
    CREATE FUNCTION test_fail_outbox() RETURNS trigger AS $$
    BEGIN
      IF NEW.payload->'data'->'money'->>'amount' = '777.77' THEN
        RAISE EXCEPTION 'falha simulada na outbox';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER test_fail_outbox BEFORE INSERT ON outbox_messages
      FOR EACH ROW EXECUTE FUNCTION test_fail_outbox();`);
});
afterEach(async () => {
  await assertLedgerInvariants(c);
});
afterAll(async () => {
  await c.query(
    'DROP TRIGGER test_fail_outbox ON outbox_messages; DROP FUNCTION test_fail_outbox();',
  );
  await c.end();
  await orm.close(true);
});

describe('Atomicidade (falha real na última escrita)', () => {
  test('falha ao gravar o evento desfaz débito, lançamento e inbox; sobra só o FAILED auditável', async () => {
    const w = await s.createWallet.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('1000.00') },
      ctx,
    );
    const cmd = wagerCommand(w, K.Bet, '777.77');
    const inbox = {
      consumerName: 'atomic-consumer',
      messageId: `m-${Bun.randomUUIDv7()}`,
      payloadHash: 'h',
    };
    const { result } = await s.submit.execute(cmd, ctx, inbox);

    expect<string>(result.status).toBe('FAILED');
    expect(result.balance.amount).toBe('1000.00');

    const state = await c.query<{
      balance: string;
      version: string;
      ledger: string;
      outbox: string;
      tx: string;
    }>(
      `SELECT w.balance::text AS balance, w.version::text AS version,
              (SELECT COUNT(*) FROM wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id
                WHERE t.external_transaction_id = $2)::text AS ledger,
              (SELECT COUNT(*) FROM outbox_messages o WHERE o.payload->'data'->>'transactionId' IN
                 (SELECT id::text FROM wager_transactions WHERE external_transaction_id = $2))::text AS outbox,
              (SELECT status FROM wager_transactions WHERE external_transaction_id = $2) AS tx
         FROM wallets w WHERE w.id = $1`,
      [w.id, cmd.externalTransactionId],
    );
    expect(state.rows[0]).toEqual({
      balance: '1000.00',
      version: '1',
      ledger: '0',
      outbox: '0',
      tx: 'FAILED',
    });

    // A inbox foi gravada SÓ junto com o FAILED (transação própria). A redelivery é absorvida.
    const again = await s.submit.execute(cmd, ctx, inbox);
    expect(again.duplicateMessage).toBe(true);
    expect(again.result.idempotentReplay).toBe(true);
  });

  test('operação vizinha na mesma wallet não é afetada', async () => {
    const w = await s.createWallet.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('1000.00') },
      ctx,
    );
    await s.submit.execute(wagerCommand(w, K.Bet, '777.77'), ctx);
    const ok = await s.submit.execute(wagerCommand(w, K.Bet, '100.00'), ctx);
    expect<string>(ok.result.status).toBe('PROCESSED');
    expect(ok.result.balance.amount).toBe('900.00');
  });
});
