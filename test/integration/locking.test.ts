/**
 * Etapa 9 — lock pessimista por wallet sobre PostgreSQL real.
 * Prova: (1) mesma wallet serializa, sem lost update; (2) wallets distintas não
 * se bloqueiam (sem lock global); (3) espera além do lock_timeout vira erro
 * transitório; (4) round-trip dos repositórios preserva Money exato.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  TransientInfrastructureError,
  WalletAlreadyExistsError,
} from '../../src/application/errors';
import { Money } from '../../src/domain/money/money';
import { Wallet } from '../../src/domain/wallet/wallet';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { resetDatabase } from '../support/database';

const uuid = (): string => Bun.randomUUIDv7();
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  orm = await resetDatabase();
  uow = new MikroOrmUnitOfWork(orm, 5000);
});
afterAll(async () => {
  await orm.close(true);
});

async function createWallet(balance: string): Promise<string> {
  const { wallet } = Wallet.open({
    id: uuid(),
    playerId: uuid(),
    initialBalance: brl('0.00'),
    openingTransactionId: uuid(),
    openingEntryId: uuid(),
    at: new Date(),
  });
  // Saldo inicial gravado direto (sem OPENING) só para isolar o teste de lock.
  const seeded = Wallet.rehydrate({
    id: wallet.id,
    playerId: wallet.playerId,
    currency: 'BRL',
    balance: brl(balance),
    version: 1,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  });
  await uow.run((s) => s.wallets.insert(seeded));
  return wallet.id;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Lock pessimista por wallet', () => {
  test('mesma wallet: a segunda transação espera o commit da primeira (sem lost update)', async () => {
    const walletId = await createWallet('100.00');
    const firstLocked = deferred();
    const releaseFirst = deferred();
    const events: string[] = [];

    const first = uow.run(async (s) => {
      const w = await s.wallets.lockById(walletId);
      events.push('first:locked');
      firstLocked.resolve();
      await releaseFirst.promise;
      w?.debit({ entryId: uuid(), transactionId: uuid(), money: brl('30.00'), at: new Date() });
      if (w) await s.wallets.save(w);
      events.push('first:commit');
    });

    await firstLocked.promise;
    const second = uow.run(async (s) => {
      const w = await s.wallets.lockById(walletId);
      events.push(`second:locked balance=${w?.balance.toString() ?? '?'}`);
      w?.debit({ entryId: uuid(), transactionId: uuid(), money: brl('30.00'), at: new Date() });
      if (w) await s.wallets.save(w);
    });

    // Dá tempo de a segunda tentar o lock enquanto a primeira segura.
    await Bun.sleep(150);
    expect(events).toEqual(['first:locked']);
    releaseFirst.resolve();
    await Promise.all([first, second]);

    // A segunda leu o saldo JÁ debitado pela primeira: 70.00, não 100.00.
    expect(events).toEqual(['first:locked', 'first:commit', 'second:locked balance=70.00']);
    const final = await uow.run((s) => s.wallets.findById(walletId));
    expect(final?.balance.toString()).toBe('40.00');
    expect(final?.version).toBe(3);
  });

  test('wallets distintas: lock de A não bloqueia B (Restrição #6)', async () => {
    const a = await createWallet('10.00');
    const b = await createWallet('10.00');
    const aLocked = deferred();
    const releaseA = deferred();

    const holdA = uow.run(async (s) => {
      await s.wallets.lockById(a);
      aLocked.resolve();
      await releaseA.promise;
    });
    await aLocked.promise;

    const started = performance.now();
    await uow.run(async (s) => {
      const w = await s.wallets.lockById(b);
      expect(w?.id).toBe(b);
    });
    const elapsed = performance.now() - started;
    releaseA.resolve();
    await holdA;
    expect(elapsed).toBeLessThan(500);
  });

  test('espera além do lock_timeout vira TransientInfrastructureError (nada gravado)', async () => {
    const walletId = await createWallet('10.00');
    const shortUow = new MikroOrmUnitOfWork(orm, 200);
    const locked = deferred();
    const release = deferred();
    const hold = uow.run(async (s) => {
      await s.wallets.lockById(walletId);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    let caught: unknown;
    try {
      await shortUow.run(async (s) => {
        await s.wallets.lockById(walletId);
      });
    } catch (error: unknown) {
      caught = error;
    }
    release.resolve();
    await hold;
    expect(caught).toBeInstanceOf(TransientInfrastructureError);
  });
});

describe('Repositórios', () => {
  test('wallet: round-trip preserva Money exato (string, nunca number)', async () => {
    const id = await createWallet('9999999999999999.99');
    const w = await uow.run((s) => s.wallets.findById(id));
    expect(w?.balance.toJSON()).toEqual({ amount: '9999999999999999.99', currency: 'BRL' });
    expect(w?.version).toBe(1);
  });

  test('wallet duplicada (player + moeda) vira WalletAlreadyExistsError', async () => {
    const playerId = uuid();
    const open = () =>
      Wallet.open({
        id: uuid(),
        playerId,
        initialBalance: brl('0.00'),
        openingTransactionId: uuid(),
        openingEntryId: uuid(),
        at: new Date(),
      }).wallet;
    await uow.run((s) => s.wallets.insert(open()));
    let caught: unknown;
    try {
      await uow.run((s) => s.wallets.insert(open()));
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WalletAlreadyExistsError);
  });

  test('wallet inexistente: lockById devolve undefined', async () => {
    expect(await uow.run((s) => s.wallets.lockById(uuid()))).toBeUndefined();
  });
});
