import { Money } from '../../src/domain/money/money';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '../../src/domain/wager-transaction/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction-kind';
import { Wallet } from '../../src/domain/wallet/wallet';

export { WagerTransactionKind };

export const id = (): string => crypto.randomUUID();
export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
export const T0 = new Date('2026-07-29T15:00:00.000Z');
export const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

export function openWallet(initial: string, playerId: string = id()): Wallet {
  return Wallet.open({
    id: id(),
    playerId,
    initialBalance: brl(initial),
    openingTransactionId: id(),
    openingEntryId: id(),
    at: T0,
  }).wallet;
}

export interface TxOverrides extends Partial<Omit<CreateWagerTransactionProps, 'money'>> {
  money?: Money;
}

/** Transação PENDING com defaults coerentes com a wallet informada. */
export function newTx(
  wallet: Wallet,
  kind: WagerTransactionKind,
  amount: string,
  overrides: TxOverrides = {},
): WagerTransaction {
  const ext = overrides.externalTransactionId ?? `tx-${id()}`;
  return WagerTransaction.create({
    id: id(),
    providerId: 'provider-a',
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    createdAt: T0,
    ...overrides,
  });
}
