/**
 * Composition root: monta o grafo de objetos em TypeScript puro. O NestJS só
 * recebe as instâncias prontas (useValue), e o framework fica restrito às
 * camadas de interface.
 */
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { AllowAllProviderIdentity } from './application/ports/provider-identity';
import { CreateWalletUseCase } from './application/use-cases/create-wallet';
import {
  CompositeOutcomeListener,
  PendingReferenceProcessor,
} from './application/use-cases/pending-reference-processor';
import { PublishOutboxUseCase } from './application/use-cases/publish-outbox';
import { WalletQueries } from './application/use-cases/queries';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet';
import { SubmitWagerTransactionUseCase } from './application/use-cases/submit-wager-transaction';
import { PendingReferencePolicy } from './domain/wager-transaction/pending-reference-policy';
import type { AppConfig } from './infrastructure/config/app-config';
import {
  LoggingEventPublisher,
  SqsEventPublisher,
  consumerSqsClient,
  createSqsClient,
} from './infrastructure/messaging/sqs';
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager-consumer';
import { createOrm } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from './infrastructure/system';
import { PollingWorker } from './infrastructure/workers/polling-worker';
import { type AppLogger, JsonLogger, parseLogLevel } from './shared/logger';
import { AppMetrics } from './shared/metrics';

export interface HealthReport {
  status: 'ok' | 'unavailable';
  checks: { postgres: 'up' | 'down'; sqs: 'up' | 'down' };
}

export class HealthService {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async readiness(): Promise<HealthReport> {
    const [postgres, sqs] = await Promise.all([
      withTimeout(this.orm.em.fork().execute('SELECT 1')),
      withTimeout(
        this.sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['QueueArn'] }),
        ),
      ),
    ]);
    const checks = { postgres: postgres ? 'up' : 'down', sqs: sqs ? 'up' : 'down' } as const;
    return { status: postgres && sqs ? 'ok' : 'unavailable', checks };
  }
}

async function withTimeout(promise: Promise<unknown>, ms = 2000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, ms);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class Workers {
  private started = false;
  constructor(
    private readonly consumer: SqsWagerConsumer,
    private readonly outbox: PollingWorker,
    private readonly extra: PollingWorker[] = [],
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.consumer.start();
    this.outbox.start();
    for (const w of this.extra) w.start();
  }

  /** Ordem de parada: para de consumir primeiro, depois drena os workers. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.consumer.stop();
    await Promise.all([this.outbox.stop(), ...this.extra.map((w) => w.stop())]);
  }
}

export interface Container {
  config: AppConfig;
  orm: MikroORM;
  logger: AppLogger;
  metrics: AppMetrics;
  sqs: SQSClient;
  uow: MikroOrmUnitOfWork;
  createWallet: CreateWalletUseCase;
  submitWager: SubmitWagerTransactionUseCase;
  queries: WalletQueries;
  reconcile: ReconcileWalletUseCase;
  publishOutbox: PublishOutboxUseCase;
  pendingReferences: PendingReferenceProcessor;
  health: HealthService;
  workers: Workers;
  close(): Promise<void>;
}

export async function buildContainer(config: AppConfig, logger?: AppLogger): Promise<Container> {
  const log = logger ?? new JsonLogger(parseLogLevel(process.env.LOG_LEVEL));
  const metrics = new AppMetrics();
  const orm = await createOrm(config.database);
  const sqs = createSqsClient(config.sqs);
  const uow = new MikroOrmUnitOfWork(orm, config.database.lockTimeoutMs, metrics);
  const ids = new UuidV7Generator();
  const clock = new SystemClock();
  const pr = config.pendingReference;
  const policy = new PendingReferencePolicy({
    ttlMs: pr.ttlSeconds * 1000,
    baseDelayMs: pr.backoffBaseSeconds * 1000,
    maxDelayMs: pr.backoffMaxSeconds * 1000,
    maxAttempts: pr.maxAttempts,
  });

  const pendingReferences = new PendingReferenceProcessor(
    uow,
    ids,
    clock,
    policy,
    {
      error: (msg, fields) => {
        log.error(msg, fields);
      },
    },
    metrics,
  );
  // Métricas + gatilho imediato dos dependentes de PENDING_REFERENCE.
  const outcomeListener = new CompositeOutcomeListener().add(metrics).add(pendingReferences);
  const submitWager = new SubmitWagerTransactionUseCase(
    uow,
    ids,
    clock,
    policy,
    outcomeListener,
    new AllowAllProviderIdentity(),
  );
  const publishOutbox = new PublishOutboxUseCase(
    uow,
    new LoggingEventPublisher(
      new SqsEventPublisher(sqs, config.sqs.eventsQueueUrl),
      log.child({ component: 'outbox' }),
    ),
    clock,
    config.outbox,
  );

  const outboxWorker = new PollingWorker(
    'outbox',
    config.outbox.pollIntervalMs,
    async () => {
      const report = await publishOutbox.execute();
      if (report.overdue > 0) {
        metrics.outboxOverdue.inc(report.overdue);
        log.warn('eventos da outbox acima do limite de tentativas', { overdue: report.overdue });
      }
      const stats = await uow.run((s) => s.outbox.pendingStats(clock.now()));
      metrics.outboxPending.set(stats.pending);
      metrics.outboxLag.set(stats.oldestAgeSeconds);
      return report.published > 0;
    },
    {
      error: (msg, ctx) => {
        log.error(msg, { error: String(ctx.error) });
      },
    },
  );
  const consumerSqs = consumerSqsClient(config.sqs);
  const consumer = new SqsWagerConsumer(
    consumerSqs,
    config.sqs,
    submitWager,
    log.child({ component: 'sqs-consumer' }),
    metrics,
    config.faults,
  );
  const pendingWorker = new PollingWorker(
    'pending-reference',
    pr.pollIntervalMs,
    async () => (await pendingReferences.runDue(50)) > 0,
    {
      error: (msg, ctx) => {
        log.error(msg, { error: String(ctx.error) });
      },
    },
  );
  const workers = new Workers(consumer, outboxWorker, [pendingWorker]);

  return {
    config,
    orm,
    logger: log,
    metrics,
    sqs,
    uow,
    createWallet: new CreateWalletUseCase(uow, ids, clock),
    submitWager,
    queries: new WalletQueries(uow),
    // Divergência: log de erro + métrica; nunca autocorreção.
    reconcile: new ReconcileWalletUseCase(uow, {
      onDivergence: (report) => {
        metrics.reconciliationDivergence.inc();
        log.error('divergência entre saldo e ledger', {
          walletId: report.walletId,
          storedBalance: report.storedBalance.amount,
          calculatedBalance: report.calculatedBalance.amount,
          difference: report.difference.amount,
          checkedEntries: report.checkedEntries,
        });
      },
    }),
    publishOutbox,
    pendingReferences,
    health: new HealthService(orm, sqs, config.sqs.transactionsQueueUrl),
    workers,
    async close() {
      await workers.stop();
      await orm.close(true);
      sqs.destroy();
      consumerSqs.destroy();
    },
  };
}
