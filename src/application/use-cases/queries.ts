/**
 * Consultas (GET). Leitura sem lock: nenhuma decide saldo nem escreve.
 */
import type { MoneyProps } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { TransactionNotFoundError, WalletNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/unit-of-work';
import { type WalletView, toWalletView } from './create-wallet';

export interface TransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  /** Saldo observado quando ficou terminal (null enquanto pendente). */
  observedBalance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  walletId: string;
  entries: LedgerEntryView[];
  /** seq do último item; a camada HTTP transforma em cursor opaco. */
  nextAfterSeq: string | undefined;
}

export function toTransactionView(tx: WagerTransaction): TransactionView {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    status: tx.status,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    failureCode: tx.failureCode ?? null,
    observedBalance: tx.observedBalance?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run((s) => s.wallets.findById(walletId));
    if (wallet === undefined) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }

  async getLedger(
    walletId: string,
    afterSeq: string | undefined,
    limit: number,
  ): Promise<LedgerPageView> {
    return this.uow.run(async (s) => {
      if ((await s.wallets.findById(walletId)) === undefined)
        throw new WalletNotFoundError(walletId);
      const page = await s.ledger.list(walletId, afterSeq, limit);
      return {
        walletId,
        entries: page.entries.map((e) => ({
          id: e.id,
          transactionId: e.transactionId,
          direction: e.direction,
          money: e.money.toJSON(),
          balanceBefore: e.balanceBefore.toJSON(),
          balanceAfter: e.balanceAfter.toJSON(),
          createdAt: e.createdAt.toISOString(),
        })),
        nextAfterSeq: page.nextAfterSeq,
      };
    });
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    const tx = await this.uow.run((s) => s.transactions.findById(transactionId));
    if (tx === undefined) throw new TransactionNotFoundError(transactionId);
    return toTransactionView(tx);
  }

  async getByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView> {
    const tx = await this.uow.run((s) =>
      s.transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (tx === undefined)
      throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return toTransactionView(tx);
  }
}
