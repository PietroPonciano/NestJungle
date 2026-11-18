/**
 * Eventos de integração mínimos (enunciado §11).
 *
 * Invariantes:
 *  - aggregateId = walletId em todos os eventos. Na fila de eventos,
 *    MessageGroupId = aggregateId, o que preserva a ordem por wallet.
 *  - WagerTransactionProcessed: qualquer transação aplicada, inclusive LOSS e
 *    OPENING (D3).
 *  - WagerTransactionRejected: rejeição de negócio, inclusive a expiração de
 *    PENDING_REFERENCE (REFERENCE_NOT_FOUND).
 *  - WalletBalanceChanged: SOMENTE quando o saldo muda (nasce de um lançamento
 *    do ledger, então LOSS/REJECTED não conseguem produzi-lo).
 *  - WagerTransactionPendingReference: referência ausente.
 *  - Campos opcionais usam `null` em vez de ausência, para o schema do payload
 *    ser estável entre eventos do mesmo tipo.
 */
import type { MoneyProps } from '../../money/money';
import type { FailureCode } from '../../wager-transaction/failure-code';
import type { WagerTransaction } from '../../wager-transaction/wager-transaction';
import {
  WagerTransactionStatus,
  type WagerTransactionKind,
} from '../../wager-transaction/wager-transaction-kind';
import type { LedgerDirection } from '../../wallet/ledger-direction';
import type { Wallet } from '../../wallet/wallet';
import type { WalletLedgerEntry } from '../../wallet/wallet-ledger-entry';
import { InvariantViolationError } from '../domain-error';
import { type EventContext, IntegrationEvent } from './integration-event';

// ------------------------------------------------------------------ Processed
export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus.Processed;
  money: MoneyProps;
  referenceTransactionId: string | null;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (tx.status !== WagerTransactionStatus.Processed) {
      throw new InvariantViolationError('WagerTransactionProcessed exige transação PROCESSED');
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        kind: tx.kind,
        status: WagerTransactionStatus.Processed,
        money: tx.money.toJSON(),
        referenceTransactionId: tx.referenceTransactionId ?? null,
      },
    });
  }
}

// ------------------------------------------------------------------- Rejected
export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (tx.status !== WagerTransactionStatus.Rejected || tx.failureCode === undefined) {
      throw new InvariantViolationError('WagerTransactionRejected exige transação REJECTED');
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: tx.failureCode,
      },
    });
  }
}

// ------------------------------------------------------- WalletBalanceChanged
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvariantViolationError('Lançamento não pertence à wallet');
    }
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

// ---------------------------------------------------------- PendingReference
export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  referenceExternalTransactionId: string;
  expiresAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (
      tx.status !== WagerTransactionStatus.PendingReference ||
      tx.referenceExternalTransactionId === undefined ||
      tx.expiresAt === undefined
    ) {
      throw new InvariantViolationError(
        'WagerTransactionPendingReference exige transação PENDING_REFERENCE',
      );
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.walletId,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        kind: tx.kind,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        expiresAt: tx.expiresAt.toISOString(),
      },
    });
  }
}
