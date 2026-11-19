/**
 * Restrições #5 e #9 com a credencial de RUNTIME: o role `wagering_app`
 * (Migration002) não é dono das tabelas, então não consegue burlar o ledger
 * nem as transações terminais — nem desligando triggers. E o trigger de
 * estado terminal vale até para o dono do schema.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { APP_ROLE } from '../../migrations/Migration20261119000002AppRoleAndTerminalGuard';
import { expectPgError, pgClient, resetDatabase } from '../support/database';

const uuid = (): string => Bun.randomUUIDv7();
const INSUFFICIENT_PRIVILEGE = '42501';

let orm: MikroORM;
let c: Client;

beforeAll(async () => {
  orm = await resetDatabase();
  c = await pgClient();
});
afterEach(async () => {
  await c.query('RESET ROLE');
});
afterAll(async () => {
  await c.end();
  await orm.close(true);
});

/** Wallet + transação no status pedido + (se PROCESSED) lançamento. */
async function seed(
  status: 'PROCESSED' | 'PENDING_REFERENCE',
): Promise<{ walletId: string; txId: string }> {
  const walletId = uuid();
  const txId = uuid();
  const ext = `ext-${uuid()}`;
  await c.query(
    "INSERT INTO wallets (id, player_id, currency, balance) VALUES ($1, $2, 'BRL', '90.00')",
    [walletId, uuid()],
  );
  await c.query(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, status, amount, currency, reference_external_transaction_id,
        observed_balance, processed_at)
     VALUES ($1, 'p', $2, $3, 'h', $4, $5, 'r', 'g', $6, $7, '10.00', 'BRL', $8, '90.00', $9)`,
    [
      txId,
      ext,
      `k-${ext}`,
      walletId,
      uuid(),
      status === 'PROCESSED' ? 'BET' : 'REFUND',
      status,
      status === 'PROCESSED' ? null : 'missing-bet',
      status === 'PROCESSED' ? new Date() : null,
    ],
  );
  if (status === 'PROCESSED') {
    await c.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'DEBIT', '10.00', 'BRL', '100.00', '90.00')`,
      [uuid(), walletId, txId],
    );
  }
  return { walletId, txId };
}

describe('Role de runtime (wagering_app)', () => {
  test('não é superusuário nem pode logar diretamente (role de grupo)', async () => {
    const r = await c.query<{ rolsuper: boolean; rolcanlogin: boolean }>(
      'SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = $1',
      [APP_ROLE],
    );
    expect(r.rows[0]).toEqual({ rolsuper: false, rolcanlogin: false });
  });

  test('ledger: INSERT permitido; UPDATE, DELETE, TRUNCATE e DISABLE TRIGGER negados', async () => {
    const { walletId } = await seed('PROCESSED');
    await c.query(`SET ROLE ${APP_ROLE}`);
    for (const sql of [
      'UPDATE wallet_ledger_entries SET amount = amount',
      'DELETE FROM wallet_ledger_entries',
      'TRUNCATE wallet_ledger_entries',
    ]) {
      expect((await expectPgError(c.query(sql))).code).toBe(INSUFFICIENT_PRIVILEGE);
    }
    // Não é dono: não consegue desligar a proteção.
    const e = await expectPgError(
      c.query('ALTER TABLE wallet_ledger_entries DISABLE TRIGGER trg_ledger_immutable_row'),
    );
    expect(e.code).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      (await expectPgError(c.query('DROP TRIGGER trg_tx_guard_update ON wager_transactions'))).code,
    ).toBe(INSUFFICIENT_PRIVILEGE);

    // O fluxo normal continua funcionando como app: wallet + transação +
    // lançamento (seq IDENTITY incluído).
    const asApp = await seed('PROCESSED');
    for (const id of [walletId, asApp.walletId]) {
      const r = await c.query(
        'SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = $1',
        [id],
      );
      expect(r.rows[0]).toEqual({ n: 1 });
    }
  });

  test('wager_transactions: sem DELETE para a aplicação', async () => {
    const { txId } = await seed('PENDING_REFERENCE');
    await c.query(`SET ROLE ${APP_ROLE}`);
    const e = await expectPgError(c.query('DELETE FROM wager_transactions WHERE id = $1', [txId]));
    expect(e.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('Trigger de imutabilidade em wager_transactions (vale até para o dono)', () => {
  test('transação terminal não muda de status nem de saldo observado', async () => {
    const { txId } = await seed('PROCESSED');
    for (const sql of [
      "UPDATE wager_transactions SET status = 'PENDING', processed_at = NULL WHERE id = $1",
      "UPDATE wager_transactions SET observed_balance = '1.00' WHERE id = $1",
    ]) {
      const e = await expectPgError(c.query(sql, [txId]));
      expect(e.message).toContain('estado terminal');
    }
  });

  test('PENDING_REFERENCE pode avançar, mas identidade e payload nunca mudam', async () => {
    const { txId } = await seed('PENDING_REFERENCE');
    await c.query(
      'UPDATE wager_transactions SET attempts = attempts + 1, next_attempt_at = now() WHERE id = $1',
      [txId],
    );
    for (const sql of [
      "UPDATE wager_transactions SET amount = '999.00' WHERE id = $1",
      "UPDATE wager_transactions SET payload_hash = 'x' WHERE id = $1",
      "UPDATE wager_transactions SET idempotency_key = 'other' WHERE id = $1",
    ]) {
      const e = await expectPgError(c.query(sql, [txId]));
      expect(e.message).toContain('imutáveis');
    }
  });

  test('DELETE e TRUNCATE bloqueados mesmo para o dono', async () => {
    const { txId } = await seed('PENDING_REFERENCE');
    expect(
      (await expectPgError(c.query('DELETE FROM wager_transactions WHERE id = $1', [txId])))
        .message,
    ).toContain('auditável');
    expect((await expectPgError(c.query('TRUNCATE wager_transactions CASCADE'))).message).toContain(
      'auditável',
    );
  });
});
