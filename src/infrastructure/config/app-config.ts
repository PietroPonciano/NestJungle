/**
 * Configuração tipada lida das variáveis de ambiente (ver .env.example).
 * Falha cedo, na inicialização, se um valor obrigatório estiver inválido.
 */
export interface AppConfig {
  port: number;
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    poolMax: number;
    /** lock_timeout por transação: espera por lock de wallet além disso = transitório (503). */
    lockTimeoutMs: number;
  };
  sqs: {
    region: string;
    endpoint: string | undefined;
    accessKeyId: string;
    secretAccessKey: string;
    transactionsQueueUrl: string;
    transactionsDlqUrl: string;
    eventsQueueUrl: string;
    maxReceiveCount: number;
    visibilityTimeoutSeconds: number;
    waitTimeSeconds: number;
    consumerName: string;
    retryBaseSeconds: number;
    retryMaxSeconds: number;
  };
  outbox: {
    pollIntervalMs: number;
    batchSize: number;
    retryMaxSeconds: number;
    lagAlertAttempts: number;
    /** Intervalo de amostragem das métricas outbox_pending_total e outbox_lag_seconds. */
    metricsIntervalMs: number;
  };
  pendingReference: {
    ttlSeconds: number;
    backoffBaseSeconds: number;
    backoffMaxSeconds: number;
    maxAttempts: number;
    pollIntervalMs: number;
  };
  /** Liga consumidor SQS e workers (outbox, pendências) nesta instância. */
  workersEnabled: boolean;
  /**
   * Injeção de falhas para os testes de crash (Etapa 18). DESLIGADA por padrão;
   * nunca habilitar em produção.
   */
  faults: {
    /** Mata o processo (SIGKILL) depois do commit e ANTES do ack da mensagem SQS. */
    crashAfterCommitBeforeAck: boolean;
  };
}

type Env = Readonly<Record<string, string | undefined>>;

function str(env: Env, key: string, fallback?: string): string {
  const value = env[key] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  }
  return value;
}

function int(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== raw.trim()) {
    throw new Error(`Variável ${key} deve ser inteiro não negativo: "${raw}"`);
  }
  return value;
}

function intAtLeast(env: Env, key: string, fallback: number, min: number): number {
  const value = int(env, key, fallback);
  if (value < min) {
    throw new Error(`Variável ${key} deve ser inteiro >= ${String(min)}: "${String(value)}"`);
  }
  return value;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Variável ${key} deve ser true ou false: "${raw}"`);
}

export function loadConfig(env: Env = process.env): AppConfig {
  const sqsEndpoint = env.SQS_ENDPOINT === '' ? undefined : env.SQS_ENDPOINT;
  const queueBase = `${sqsEndpoint ?? 'http://localhost:4566'}/000000000000`;
  return {
    port: int(env, 'PORT', 3000),
    database: {
      host: str(env, 'DATABASE_HOST', 'localhost'),
      port: int(env, 'DATABASE_PORT', 5432),
      name: str(env, 'DATABASE_NAME', 'wagering'),
      user: str(env, 'DATABASE_USER', 'wagering'),
      password: str(env, 'DATABASE_PASSWORD', 'wagering'),
      poolMax: int(env, 'DATABASE_POOL_MAX', 20),
      lockTimeoutMs: int(env, 'DATABASE_LOCK_TIMEOUT_MS', 5000),
    },
    sqs: {
      region: str(env, 'AWS_REGION', 'us-east-1'),
      endpoint: sqsEndpoint,
      accessKeyId: str(env, 'AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: str(env, 'AWS_SECRET_ACCESS_KEY', 'test'),
      transactionsQueueUrl: str(
        env,
        'SQS_TRANSACTIONS_QUEUE_URL',
        `${queueBase}/wager-transactions.fifo`,
      ),
      transactionsDlqUrl: str(
        env,
        'SQS_TRANSACTIONS_DLQ_URL',
        `${queueBase}/wager-transactions-dlq.fifo`,
      ),
      eventsQueueUrl: str(env, 'SQS_EVENTS_QUEUE_URL', `${queueBase}/wager-events.fifo`),
      maxReceiveCount: int(env, 'SQS_MAX_RECEIVE_COUNT', 5),
      visibilityTimeoutSeconds: int(env, 'SQS_VISIBILITY_TIMEOUT_SECONDS', 60),
      waitTimeSeconds: int(env, 'SQS_WAIT_TIME_SECONDS', 20),
      consumerName: str(env, 'SQS_CONSUMER_NAME', 'wager-transactions-consumer'),
      retryBaseSeconds: int(env, 'SQS_RETRY_BASE_SECONDS', 5),
      retryMaxSeconds: int(env, 'SQS_RETRY_MAX_SECONDS', 300),
    },
    outbox: {
      pollIntervalMs: int(env, 'OUTBOX_POLL_INTERVAL_MS', 500),
      batchSize: int(env, 'OUTBOX_BATCH_SIZE', 50),
      retryMaxSeconds: int(env, 'OUTBOX_RETRY_MAX_SECONDS', 300),
      lagAlertAttempts: int(env, 'OUTBOX_LAG_ALERT_ATTEMPTS', 10),
      // Mínimo de 100 ms: com 0 o laço de amostragem viraria espera ocupada.
      metricsIntervalMs: intAtLeast(env, 'OUTBOX_METRICS_INTERVAL_MS', 5000, 100),
    },
    pendingReference: {
      ttlSeconds: int(env, 'PENDING_REFERENCE_TTL_SECONDS', 3600),
      backoffBaseSeconds: int(env, 'PENDING_REFERENCE_BACKOFF_BASE_SECONDS', 2),
      backoffMaxSeconds: int(env, 'PENDING_REFERENCE_BACKOFF_MAX_SECONDS', 300),
      maxAttempts: int(env, 'PENDING_REFERENCE_MAX_ATTEMPTS', 20),
      pollIntervalMs: int(env, 'PENDING_REFERENCE_POLL_INTERVAL_MS', 1000),
    },
    workersEnabled: bool(env, 'WORKERS_ENABLED', true),
    faults: {
      crashAfterCommitBeforeAck: bool(env, 'FAULT_CRASH_AFTER_COMMIT_BEFORE_ACK', false),
    },
  };
}
