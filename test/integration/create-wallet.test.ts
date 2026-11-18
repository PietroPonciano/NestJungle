import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { WalletAlreadyExistsError } from '../../src/application/errors';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet';
import { Money } from '../../src/domain/money/money';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system';
import { pgClient, resetDatabase } from '../support/database';
import { assertLedgerInvariants } from '../support/invariants';

let orm: MikroORM;
let c: Client;
let useCase: CreateWalletUseCase;
const ctx = { correlationId: 'corr-1' };
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

beforeAll(async () => {
  orm = await resetDatabase();
  c = await pgClient();
  useCase = new CreateWalletUseCase(
    new MikroOrmUnitOfWork(orm, 5000),
    new UuidV7Generator(),
    new SystemClock(),
  );
});
afterEach(async () => {
  await assertLedgerInvariants(c);
});
afterAll(async () => {
  await c.end();
  await orm.close(true);
});

describe('CreateWalletUseCase (PostgreSQL real)', () => {
  test('saldo inicial > 0: wallet v1 + OPENING PROCESSED + CREDIT + 2 eventos, atômicos', async () => {
    const playerId = Bun.randomUUIDv7();
    const view = await useCase.execute({ playerId, initialBalance: brl('1000.00') }, ctx);
    expect(view).toEqual({
      id: view.id,
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });

    const tx = await c.query(
      'SELECT kind, status, provider_id, external_transaction_id, observed_balance::text AS observed FROM wager_transactions WHERE wallet_id = $1',
      [view.id],
    );
    expect(tx.rows).toEqual([
      {
        kind: 'OPENING',
        status: 'PROCESSED',
        provider_id: 'internal',
        external_transaction_id: `opening:${view.id}`,
        observed: '1000.00',
      },
    ]);
    const ledger = await c.query(
      'SELECT direction, amount::text AS amount, balance_before::text AS b, balance_after::text AS a FROM wallet_ledger_entries WHERE wallet_id = $1',
      [view.id],
    );
    expect(ledger.rows).toEqual([
      { direction: 'CREDIT', amount: '1000.00', b: '0.00', a: '1000.00' },
    ]);
    const events = await c.query<{ event_type: string; correlation: string }>(
      "SELECT event_type, payload->>'correlationId' AS correlation FROM outbox_messages WHERE aggregate_id = $1 ORDER BY event_type",
      [view.id],
    );
    expect(events.rows).toEqual([
      { event_type: 'WagerTransactionProcessed', correlation: 'corr-1' },
      { event_type: 'WalletBalanceChanged', correlation: 'corr-1' },
    ]);
  });

  test('saldo inicial zero: só a wallet, sem OPENING, lançamento ou evento (D3)', async () => {
    const view = await useCase.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('0.00') },
      ctx,
    );
    expect(view.balance.amount).toBe('0.00');
    const counts = await c.query<{ t: string; l: string; o: string }>(
      `SELECT (SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = $1)::text AS t,
              (SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = $1)::text AS l,
              (SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = $1)::text AS o`,
      [view.id],
    );
    expect(counts.rows[0]).toEqual({ t: '0', l: '0', o: '0' });
  });

  test('duplicata (player + moeda): WalletAlreadyExistsError e nada órfão gravado', async () => {
    const playerId = Bun.randomUUIDv7();
    await useCase.execute({ playerId, initialBalance: brl('10.00') }, ctx);
    const before = await c.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM wager_transactions',
    );

    let caught: unknown;
    try {
      await useCase.execute({ playerId, initialBalance: brl('50.00') }, ctx);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WalletAlreadyExistsError);
    const after = await c.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM wager_transactions',
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

    // Outra moeda para o mesmo player é permitida.
    const usd = await useCase.execute(
      { playerId, initialBalance: Money.from({ amount: '5.00', currency: 'USD' }) },
      ctx,
    );
    expect(usd.balance.currency).toBe('USD');
  });

  test('duplicata concorrente: 10 criações simultâneas do mesmo player → exatamente 1 wallet', async () => {
    const playerId = Bun.randomUUIDv7();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        useCase.execute({ playerId, initialBalance: brl('1.00') }, ctx),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.every((r) => r.reason instanceof WalletAlreadyExistsError)).toBe(true);
    const n = await c.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM wallets WHERE player_id = $1',
      [playerId],
    );
    expect(n.rows[0]?.n).toBe('1');
  });
});
