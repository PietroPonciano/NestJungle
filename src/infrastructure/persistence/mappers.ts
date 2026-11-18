/**
 * Mappers record <-> domínio.
 *
 * Restrição #1: NUMERIC chega do driver como string e vira Money via
 * Money.from (string -> Decimal), sem passar por `number`.
 * As factories `rehydrate` reconstroem o estado persistido sem revalidar
 * transições (o banco já garantiu as invariantes via CHECKs).
 */
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { InvariantViolationError } from '../../domain/shared/domain-error';
import { FailureCode } from '../../domain/wager-transaction/failure-code';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction-kind';
import { LedgerDirection } from '../../domain/wallet/ledger-direction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });

function oneOf<T extends string>(values: readonly T[], value: string, field: string): T {
  const found = values.find((v) => v === value);
  if (found === undefined)
    throw new InvariantViolationError(`${field} desconhecido no banco: ${value}`);
  return found;
}

// ----------------------------------------------------------------- Wallet
export function walletToDomain(r: WalletRecord): Wallet {
  if (!Number.isSafeInteger(r.version)) {
    throw new InvariantViolationError(`version fora do intervalo seguro: ${String(r.version)}`);
  }
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: money(r.balance, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function walletToRecord(w: Wallet): WalletRecord {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: w.balance.toString(),
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

// ------------------------------------------------------- WagerTransaction
export function transactionToDomain(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: oneOf(Object.values(WagerTransactionKind), r.kind, 'kind'),
    money: money(r.amount, r.currency),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    createdAt: r.createdAt,
    status: oneOf(Object.values(WagerTransactionStatus), r.status, 'status'),
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode:
      r.failureCode === null
        ? undefined
        : oneOf(Object.values(FailureCode), r.failureCode, 'failureCode'),
    observedBalance: r.observedBalance === null ? undefined : money(r.observedBalance, r.currency),
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt ?? undefined,
    expiresAt: r.expiresAt ?? undefined,
    processedAt: r.processedAt ?? undefined,
    updatedAt: r.updatedAt,
  });
}

export function transactionToRecord(t: WagerTransaction): WagerTransactionRecord {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    payloadHash: t.payloadHash,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    status: t.status,
    amount: t.money.toString(),
    currency: t.money.currency,
    referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    referenceTransactionId: t.referenceTransactionId ?? null,
    failureCode: t.failureCode ?? null,
    observedBalance: t.observedBalance?.toString() ?? null,
    attempts: t.attempts,
    nextAttemptAt: t.nextAttemptAt ?? null,
    expiresAt: t.expiresAt ?? null,
    processedAt: t.processedAt ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ------------------------------------------------------------------ Ledger
export function ledgerToDomain(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: oneOf(Object.values(LedgerDirection), r.direction, 'direction'),
    money: money(r.amount, r.currency),
    balanceBefore: money(r.balanceBefore, r.currency),
    balanceAfter: money(r.balanceAfter, r.currency),
    createdAt: r.createdAt,
  });
}

export function ledgerToRecord(e: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    amount: e.money.toString(),
    currency: e.money.currency,
    balanceBefore: e.balanceBefore.toString(),
    balanceAfter: e.balanceAfter.toString(),
    createdAt: e.createdAt,
  };
}

// ----------------------------------------------------------- Inbox/Outbox
export function inboxToDomain(r: InboxRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: r.consumerName,
    messageId: r.messageId,
    payloadHash: r.payloadHash,
    receivedAt: r.receivedAt,
    processedAt: r.processedAt ?? undefined,
  });
}

export function inboxToRecord(m: InboxMessage): InboxRecord {
  return {
    consumerName: m.consumerName,
    messageId: m.messageId,
    payloadHash: m.payloadHash,
    receivedAt: m.receivedAt,
    processedAt: m.processedAt ?? null,
  };
}

export function outboxToDomain(r: OutboxRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    publishedAt: r.publishedAt ?? undefined,
    lastError: r.lastError ?? undefined,
  });
}

export function outboxToRecord(m: OutboxMessage): OutboxRecord {
  return {
    id: m.id,
    aggregateId: m.aggregateId,
    eventType: m.eventType,
    payload: { ...m.payload },
    occurredAt: m.occurredAt,
    attempts: m.attempts,
    nextAttemptAt: m.nextAttemptAt,
    publishedAt: m.publishedAt ?? null,
    lastError: m.lastError ?? null,
  };
}
