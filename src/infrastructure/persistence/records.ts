/**
 * Records de persistência (MikroORM EntitySchema).
 *
 * O domínio não conhece o ORM (guia §2.2): estas são estruturas planas que
 * espelham as tabelas, e os mappers convertem record <-> domínio.
 *
 * Dinheiro (Restrição #1): colunas NUMERIC(18,2) mapeadas com
 * DecimalType('string'). O driver `pg` devolve NUMERIC como string, e o valor
 * é reidratado em Money sem nunca passar por `number`.
 *
 * O schema em si (constraints, índices, triggers) vem da migration, nunca do
 * schema generator do ORM.
 */
import { BigIntType, DecimalType, EntitySchema } from '@mikro-orm/postgresql';

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  observedBalance: string | null;
  attempts: number;
  nextAttemptAt: Date | null;
  expiresAt: Date | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LedgerEntryRecord {
  id: string;
  /** IDENTITY gerado pelo banco; nunca enviado no INSERT. String: BIGINT do pg. */
  seq?: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export interface InboxRecord {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface OutboxRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | null;
  lastError: string | null;
}

const money = () => ({ type: new DecimalType('string'), precision: 18, scale: 2 }) as const;
const ts = () => ({ type: 'datetime', columnType: 'timestamptz' }) as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: money(),
    // BIGINT como number (decisão E6): não é dinheiro e nunca chega a 2^53.
    version: { type: new BigIntType('number') },
    createdAt: ts(),
    updatedAt: ts(),
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'text' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'text' },
    gameId: { type: 'text' },
    kind: { type: 'text' },
    status: { type: 'text' },
    amount: money(),
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    failureCode: { type: 'text', nullable: true },
    observedBalance: { ...money(), nullable: true },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...ts(), nullable: true },
    expiresAt: { ...ts(), nullable: true },
    processedAt: { ...ts(), nullable: true },
    createdAt: ts(),
    updatedAt: ts(),
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    // persist: false — a coluna é GENERATED ALWAYS AS IDENTITY.
    seq: { type: new BigIntType('string'), persist: false, nullable: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'text' },
    amount: money(),
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: money(),
    balanceAfter: money(),
    createdAt: ts(),
  },
});

export const InboxSchema = new EntitySchema<InboxRecord>({
  name: 'InboxRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: { type: 'text' },
    receivedAt: ts(),
    processedAt: { ...ts(), nullable: true },
  },
});

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  name: 'OutboxRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: ts(),
    attempts: { type: 'integer' },
    nextAttemptAt: ts(),
    publishedAt: { ...ts(), nullable: true },
    lastError: { type: 'text', nullable: true },
  },
});

export const ALL_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxSchema,
  OutboxSchema,
];
