/**
 * Infra de teste com PostgreSQL REAL (nada de mock): usa o container do
 * docker compose (`bun run test:infra`) e um banco separado, `wagering_test`.
 * Cada arquivo de teste chama `resetDatabase()` para começar do zero:
 * DROP SCHEMA + migrations reais (as mesmas da produção).
 */
import type { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { type AppConfig, loadConfig } from '../../src/infrastructure/config/app-config';
import { createOrm } from '../../src/infrastructure/persistence/mikro-orm.config';

export const TEST_DB = process.env.TEST_DATABASE_NAME ?? 'wagering_test';

/**
 * Defaults dos testes: banco wagering_test e filas PRÓPRIAS (*-test.fifo) no
 * LocalStack. Assim a suíte não disputa mensagens com uma app do compose que
 * esteja rodando nas filas reais.
 */
const QUEUE_BASE = 'http://localhost:4566/000000000000';
export const TEST_QUEUES = {
  transactions: 'wager-transactions-test.fifo',
  dlq: 'wager-transactions-dlq-test.fifo',
  events: 'wager-events-test.fifo',
} as const;
const TEST_DEFAULTS = {
  SQS_ENDPOINT: 'http://localhost:4566',
  SQS_TRANSACTIONS_QUEUE_URL: `${QUEUE_BASE}/${TEST_QUEUES.transactions}`,
  SQS_TRANSACTIONS_DLQ_URL: `${QUEUE_BASE}/${TEST_QUEUES.dlq}`,
  SQS_EVENTS_QUEUE_URL: `${QUEUE_BASE}/${TEST_QUEUES.events}`,
};

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...TEST_DEFAULTS, ...process.env, DATABASE_NAME: TEST_DB, ...overrides });
}

/** Variáveis de ambiente equivalentes, para processos filhos (Bun.spawn). */
export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...TEST_DEFAULTS, ...env, DATABASE_NAME: TEST_DB, ...overrides };
}

export async function pgClient(database: string = TEST_DB): Promise<Client> {
  const db = testConfig().database;
  const client = new Client({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database,
  });
  await client.connect();
  return client;
}

let queuesReady: Promise<void> | undefined;

/** Cria (idempotente) as filas de teste com a mesma configuração das reais. */
export function ensureTestQueues(): Promise<void> {
  queuesReady ??= (async () => {
    const { CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } =
      await import('@aws-sdk/client-sqs');
    const { createSqsClient } = await import('../../src/infrastructure/messaging/sqs');
    const client = createSqsClient(testConfig().sqs);
    try {
      const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
      const dlq = await client.send(
        new CreateQueueCommand({ QueueName: TEST_QUEUES.dlq, Attributes: fifo }),
      );
      const arn = await client.send(
        new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
      );
      const main = await client.send(
        new CreateQueueCommand({
          QueueName: TEST_QUEUES.transactions,
          Attributes: { ...fifo, VisibilityTimeout: '60' },
        }),
      );
      await client.send(
        new SetQueueAttributesCommand({
          QueueUrl: main.QueueUrl,
          Attributes: {
            RedrivePolicy: JSON.stringify({
              deadLetterTargetArn: arn.Attributes?.QueueArn,
              maxReceiveCount: '5',
            }),
          },
        }),
      );
      await client.send(
        new CreateQueueCommand({ QueueName: TEST_QUEUES.events, Attributes: fifo }),
      );
    } finally {
      client.destroy();
    }
  })();
  return queuesReady;
}

async function ensureDatabase(): Promise<void> {
  const admin = await pgClient('postgres');
  try {
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (found.rowCount === 0) await admin.query(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end();
  }
}

/** Banco vazio + migrations aplicadas + filas de teste. Devolve um ORM (feche no afterAll). */
export async function resetDatabase(): Promise<MikroORM> {
  await ensureTestQueues();
  await ensureDatabase();
  const client = await pgClient();
  try {
    // DROP SCHEMA é permitido mesmo com os triggers do ledger: eles bloqueiam
    // UPDATE/DELETE/TRUNCATE de linhas, não DDL.
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
  const orm = await createOrm(testConfig().database);
  await orm.migrator.up();
  return orm;
}

/** Erro do driver pg com código SQLSTATE e nome da constraint violada. */
export interface PgError {
  code: string;
  constraint?: string;
  message: string;
}

export async function expectPgError(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return error as PgError;
    }
    throw error;
  }
  throw new Error('Esperava erro do PostgreSQL, mas a query passou');
}
