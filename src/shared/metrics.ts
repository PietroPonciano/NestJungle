/**
 * Métricas Prometheus (enunciado §12; guia §10). Registry próprio por
 * instância da aplicação (os testes sobem várias no mesmo processo).
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { WagerOutcomeListener } from '../application/use-cases/submit-wager-transaction';
import type { WagerResult } from '../application/use-cases/wager-result';
import type { WagerTransaction } from '../domain/wager-transaction/wager-transaction';
import type { ConsumerObserver } from '../infrastructure/messaging/sqs-wager-consumer';
import type { UnitOfWorkObserver } from '../infrastructure/persistence/mikro-orm-unit-of-work';

export class AppMetrics implements WagerOutcomeListener, ConsumerObserver, UnitOfWorkObserver {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações aplicadas por kind e status final da primeira submissão',
    labelNames: ['kind', 'status'] as const,
    registers: [this.registry],
  });
  readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Submissões duplicadas detectadas (replay idempotente)',
    registers: [this.registry],
  });
  readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Mensagens SQS devolvidas para retry por erro transitório',
    registers: [this.registry],
  });
  readonly dlq = new Counter({
    name: 'wager_dlq_messages_total',
    help: 'Mensagens enviadas à DLQ, por motivo',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  readonly lockConflicts = new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Conflitos de lock (deadlock 40P01 / lock_timeout 55P03)',
    registers: [this.registry],
  });
  readonly processingDuration = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência de processamento de uma transação (HTTP ou SQS)',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  readonly outboxLag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Idade do evento pendente mais antigo da outbox',
    registers: [this.registry],
  });
  readonly outboxPending = new Gauge({
    name: 'outbox_pending_total',
    help: 'Eventos pendentes na outbox',
    registers: [this.registry],
  });
  readonly outboxOverdue = new Counter({
    name: 'outbox_overdue_total',
    help: 'Falhas de publicação de eventos que já passaram do limite de tentativas',
    registers: [this.registry],
  });
  readonly reconciliationDivergence = new Counter({
    name: 'reconciliation_divergence_total',
    help: 'Reconciliações que encontraram saldo != ledger',
    registers: [this.registry],
  });

  constructor(collectDefaults = true) {
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
  }

  // WagerOutcomeListener
  onCommitted(tx: WagerTransaction, result: WagerResult): void {
    this.transactions.inc({ kind: tx.kind, status: result.status });
  }
  onDuplicate(): void {
    this.duplicates.inc();
  }

  // ConsumerObserver
  onRetry(): void {
    this.retries.inc();
  }
  onDeadLetter(reason: string): void {
    this.dlq.inc({ reason });
  }
  onProcessingTime(seconds: number): void {
    this.processingDuration.observe({ source: 'sqs' }, seconds);
  }

  // UnitOfWorkObserver
  onLockConflict(): void {
    this.lockConflicts.inc();
  }
}
