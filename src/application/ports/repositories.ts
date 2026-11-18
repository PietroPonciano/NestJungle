/**
 * Portas de persistência usadas pelos use cases. Todas operam DENTRO de uma
 * unidade de trabalho (uma transação SQL) — ver UnitOfWork.
 *
 * Contratos de concorrência relevantes:
 *  - WalletRepository.lockById: SELECT ... FOR UPDATE da linha da wallet.
 *    É o ÚNICO lock de negócio (Restrição #6: por wallet, nunca global).
 *  - insertIfAbsent: INSERT ... ON CONFLICT DO NOTHING. Devolve false quando a
 *    linha já existia (ou foi inserida por outra transação concorrente), SEM
 *    abortar a transação SQL.
 *  - claimDue / lockDuePendingReferences: FOR UPDATE SKIP LOCKED, para várias
 *    instâncias dividirem o trabalho sem processar a mesma linha.
 */
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export interface WalletRepository {
  /** Restrição #7: trava a linha antes de qualquer leitura de saldo. */
  lockById(id: string): Promise<Wallet | undefined>;
  findById(id: string): Promise<Wallet | undefined>;
  /** Lança WalletAlreadyExistsError se (playerId, currency) já existe. */
  insert(wallet: Wallet): Promise<void>;
  /** Grava saldo/version de uma wallet obtida por lockById nesta transação. */
  save(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Busca por (providerId, idempotencyKey) OU (providerId, externalTransactionId). */
  findByIdentity(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]>;
  /** Referência, travada depois da wallet (ordem fixa wallet -> referência). */
  lockByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Já existe REFUND/ROLLBACK PROCESSED apontando para a referência (D1)? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** INSERT ... ON CONFLICT DO NOTHING. */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
  /** Atualiza estado de uma transação já existente (ex.: PENDING_REFERENCE -> terminal). */
  save(transaction: WagerTransaction): Promise<void>;
  /** PENDING_REFERENCE vencidas, travadas com SKIP LOCKED. */
  findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceRef[]>;
  /** Dependentes aguardando a referência (providerId, externalTransactionId). */
  findWaitingFor(providerId: string, externalTransactionId: string): Promise<PendingReferenceRef[]>;
}

export interface PendingReferenceRef {
  transactionId: string;
  walletId: string;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** seq do último item (base do próximo cursor) ou undefined se acabou. */
  nextAfterSeq: string | undefined;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  list(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage>;
  /** Saldo reconstruído (soma com sinal de todos os lançamentos) e quantidade. */
  reconstruct(walletId: string, currency: string): Promise<{ balance: Money; entries: number }>;
}

export interface InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}

export interface OutboxRepository {
  enqueue(message: OutboxMessage): Promise<void>;
  /** Pendentes e devidas, travadas com FOR UPDATE SKIP LOCKED. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): Promise<void>;
  /** Para métricas: pendentes e idade da mais antiga. */
  pendingStats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }>;
}
