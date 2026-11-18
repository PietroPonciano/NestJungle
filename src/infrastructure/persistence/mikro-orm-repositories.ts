/**
 * Repositórios MikroORM. Cada instância é ligada ao EntityManager da
 * transação corrente (criado pela MikroOrmUnitOfWork).
 *
 * Escritas:
 *  - INSERTs que podem colidir sob corrida usam QueryBuilder com
 *    `ON CONFLICT DO NOTHING`, executados na hora. No PostgreSQL um erro de
 *    UNIQUE aborta a transação inteira; com DO NOTHING a colisão vira
 *    "0 linhas afetadas" e o use case decide (replay ou 409).
 *  - Atualizações (wallet, transação, outbox, inbox) usam o Unit of Work:
 *    alteram o record gerenciado e o flush acontece no commit.
 *  - Ledger e outbox novos são `persist` + flush no commit. Como a linha da
 *    transação já foi inserida antes, as FKs são respeitadas.
 */
import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import { WalletAlreadyExistsError } from '../../application/errors';
import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  OutboxRepository,
  PendingReferenceRef,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/repositories';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction-kind';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { isUniqueViolation } from './db-errors';
import {
  inboxToDomain,
  inboxToRecord,
  ledgerToDomain,
  ledgerToRecord,
  outboxToDomain,
  outboxToRecord,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from './mappers';
import {
  InboxSchema,
  LedgerEntrySchema,
  OutboxSchema,
  WagerTransactionSchema,
  WalletSchema,
  type LedgerEntryRecord,
} from './records';

// ------------------------------------------------------------------ Wallet
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(id: string): Promise<Wallet | undefined> {
    // Restrição #7: nunca read→calculate→update. Travamos a linha da wallet
    // (SELECT ... FOR UPDATE) antes de ler o saldo; transações concorrentes na
    // MESMA wallet esperam aqui (até lock_timeout), e outras wallets seguem em
    // paralelo, porque o lock é só desta linha (Restrição #6, sem lock global).
    // `refresh` garante que o saldo vem do banco já sob o lock, e não do
    // identity map.
    const record = await this.em.findOne(
      WalletSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record === null ? undefined : walletToDomain(record);
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id });
    return record === null ? undefined : walletToDomain(record);
  }

  async insert(wallet: Wallet): Promise<void> {
    this.em.persist(this.em.create(WalletSchema, walletToRecord(wallet)));
    try {
      // Flush imediato para traduzir a colisão do UNIQUE em erro de aplicação (409).
      await this.em.flush();
    } catch (error: unknown) {
      if (isUniqueViolation(error, 'uq_wallets_player_currency')) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async save(wallet: Wallet): Promise<void> {
    // Identity map: devolve o record gerenciado carregado por lockById.
    const record = await this.em.findOneOrFail(WalletSchema, { id: wallet.id });
    this.em.assign(record, {
      balance: wallet.balance.toString(),
      version: wallet.version,
      updatedAt: wallet.updatedAt,
    });
  }
}

// -------------------------------------------------------- WagerTransaction
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { id });
    return record === null ? undefined : transactionToDomain(record);
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, {
      providerId,
      externalTransactionId,
    });
    return record === null ? undefined : transactionToDomain(record);
  }

  async findByIdentity(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    const records = await this.em.find(
      WagerTransactionSchema,
      { providerId, $or: [{ idempotencyKey }, { externalTransactionId }] },
      { refresh: true },
    );
    return records.map(transactionToDomain);
  }

  async lockByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    // Ordem fixa de locks (guia §6.1): primeiro a wallet (já travada pelo
    // chamador), depois a linha da referência. Todo fluxo segue a mesma ordem,
    // então dois fluxos não esperam um pelo outro em ciclo (sem deadlock).
    const record = await this.em.findOne(
      WagerTransactionSchema,
      { providerId, externalTransactionId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record === null ? undefined : transactionToDomain(record);
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    // Consulta feita sob o lock da wallet: reversões da mesma referência são da
    // mesma wallet (regra 2) e, portanto, serializadas. O índice parcial
    // uq_tx_single_reversal é a última linha de defesa (D1).
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    // ON CONFLICT DO NOTHING (sem alvo) cobre os UNIQUEs (provider, external),
    // (provider, idempotency) e o índice D1. Se outra transação inseriu a mesma
    // chave e ainda não comitou, o PostgreSQL ESPERA o desfecho dela antes de
    // decidir: não há janela para duplicata. 0 linhas = alguém chegou antes.
    const result = await this.em
      .createQueryBuilder(WagerTransactionSchema)
      .insert(transactionToRecord(transaction))
      .onConflict()
      .ignore()
      .execute<{ affectedRows: number }>('run');
    return result.affectedRows === 1;
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const record = await this.em.findOneOrFail(WagerTransactionSchema, { id: transaction.id });
    const data = transactionToRecord(transaction);
    this.em.assign(record, {
      status: data.status,
      referenceTransactionId: data.referenceTransactionId,
      failureCode: data.failureCode,
      observedBalance: data.observedBalance,
      attempts: data.attempts,
      nextAttemptAt: data.nextAttemptAt,
      expiresAt: data.expiresAt,
      processedAt: data.processedAt,
      updatedAt: data.updatedAt,
    });
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<PendingReferenceRef[]> {
    // Claim com lease: várias instâncias rodam o worker. FOR UPDATE SKIP LOCKED
    // faz cada instância pegar linhas diferentes, e empurrar next_attempt_at
    // (lease de 30 s) tira as linhas da fila dos outros workers após o commit.
    // O processamento real acontece depois, em outra transação que trava
    // wallet -> transação (mesma ordem do fluxo principal, sem deadlock).
    const rows = await this.em.execute<{ id: string; wallet_id: string }[]>(
      `UPDATE wager_transactions SET next_attempt_at = ?::timestamptz + interval '30 seconds'
        WHERE id IN (
          SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= ?
           ORDER BY next_attempt_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED)
        RETURNING id, wallet_id`,
      [now, now, limit],
    );
    return rows.map((r) => ({ transactionId: r.id, walletId: r.wallet_id }));
  }

  async findWaitingFor(
    providerId: string,
    externalTransactionId: string,
  ): Promise<PendingReferenceRef[]> {
    // Usa o índice parcial idx_tx_waiting_for_reference.
    const records = await this.em.find(
      WagerTransactionSchema,
      {
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: WagerTransactionStatus.PendingReference,
      },
      { fields: ['id', 'walletId'] },
    );
    return records.map((r) => ({ transactionId: r.id, walletId: r.walletId }));
  }
}

// ------------------------------------------------------------------ Ledger
export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  append(entry: WalletLedgerEntry): Promise<void> {
    // Append-only (Restrição #5): só INSERT; os triggers bloqueiam o resto.
    this.em.persist(this.em.create(LedgerEntrySchema, ledgerToRecord(entry)));
    return Promise.resolve();
  }

  async list(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage> {
    // Cursor por seq (IDENTITY): ordem total e estável, sem OFFSET; usa
    // idx_ledger_wallet_seq. seq viaja como string (BIGINT).
    const rows = await this.em.execute<(LedgerEntryRow & { seq: string })[]>(
      `SELECT id, seq::text AS seq, wallet_id, transaction_id, direction, amount::text AS amount,
              currency, balance_before::text AS balance_before, balance_after::text AS balance_after, created_at
         FROM wallet_ledger_entries
        WHERE wallet_id = ? AND seq > ?::bigint
        ORDER BY seq
        LIMIT ?`,
      [walletId, afterSeq ?? '0', limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((r) => ledgerToDomain(rowToLedgerRecord(r))),
      nextAfterSeq: rows.length > limit && last !== undefined ? last.seq : undefined,
    };
  }

  async reconstruct(
    walletId: string,
    currency: string,
  ): Promise<{ balance: Money; entries: number }> {
    // Saldo reconstruído = soma com sinal de TODOS os lançamentos. Feito em
    // NUMERIC no banco e devolvido como texto (Restrição #1).
    const rows = await this.em.execute<{ total: string; entries: string }[]>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS total,
              COUNT(*)::text AS entries
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    const row = rows[0];
    return {
      balance: Money.from({ amount: row?.total ?? '0', currency }),
      entries: Number.parseInt(row?.entries ?? '0', 10),
    };
  }
}

interface LedgerEntryRow {
  id: string;
  wallet_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string;
  balance_after: string;
  /** Em query crua o driver pode devolver timestamptz como string ISO. */
  created_at: Date | string;
}

function rowToLedgerRecord(r: LedgerEntryRow): LedgerEntryRecord {
  return {
    id: r.id,
    walletId: r.wallet_id,
    transactionId: r.transaction_id,
    direction: r.direction,
    amount: r.amount,
    currency: r.currency,
    balanceBefore: r.balance_before,
    balanceAfter: r.balance_after,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
  };
}

// ------------------------------------------------------------------- Inbox
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    // Redelivery concorrente (duas instâncias com a mesma mensagem): a segunda
    // espera o commit da primeira e recebe 0 linhas, sem abortar a transação.
    const result = await this.em
      .createQueryBuilder(InboxSchema)
      .insert(inboxToRecord(message))
      .onConflict()
      .ignore()
      .execute<{ affectedRows: number }>('run');
    return result.affectedRows === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(
      InboxSchema,
      { consumerName, messageId },
      { refresh: true },
    );
    return record === null ? undefined : inboxToDomain(record);
  }
}

// ------------------------------------------------------------------ Outbox
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  enqueue(message: OutboxMessage): Promise<void> {
    // Restrição #4: o evento entra na MESMA transação do efeito financeiro.
    this.em.persist(this.em.create(OutboxSchema, outboxToRecord(message)));
    return Promise.resolve();
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    // Publishers concorrentes (Restrição #8): FOR UPDATE SKIP LOCKED faz cada
    // instância pegar um lote DIFERENTE; nenhuma espera pela outra e a mesma
    // linha não é publicada por duas ao mesmo tempo. Se o processo morrer antes
    // do commit, os locks somem e outra instância republica (seguro: o
    // consumidor deduplica por eventId).
    const records = await this.em
      .createQueryBuilder(OutboxSchema)
      .select('*')
      .where({ publishedAt: null, nextAttemptAt: { $lte: now } })
      .orderBy({ nextAttemptAt: 'asc' })
      .limit(limit)
      .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
      .getResultList();
    return records.map(outboxToDomain);
  }

  async save(message: OutboxMessage): Promise<void> {
    const record = await this.em.findOneOrFail(OutboxSchema, { id: message.id });
    const data = outboxToRecord(message);
    this.em.assign(record, {
      attempts: data.attempts,
      nextAttemptAt: data.nextAttemptAt,
      publishedAt: data.publishedAt,
      lastError: data.lastError,
    });
  }

  async pendingStats(now: Date): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const rows = await this.em.execute<{ pending: string; oldest: string | null }[]>(
      `SELECT COUNT(*)::text AS pending,
              EXTRACT(EPOCH FROM (?::timestamptz - MIN(occurred_at)))::text AS oldest
         FROM outbox_messages WHERE published_at IS NULL`,
      [now],
    );
    const row = rows[0];
    return {
      pending: Number.parseInt(row?.pending ?? '0', 10),
      oldestAgeSeconds: row?.oldest == null ? 0 : Math.max(0, Number(row.oldest)), // segundos de idade (métrica), não dinheiro
    };
  }
}
