/**
 * Etapa 12 — Transactional Outbox com PostgreSQL e LocalStack SQS REAIS.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import type { EventPublisherPort } from '../../src/application/ports/messaging';
import { PublishOutboxUseCase } from '../../src/application/use-cases/publish-outbox';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { createSqsClient, SqsEventPublisher } from '../../src/infrastructure/messaging/sqs';
import { createOrm } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../../src/infrastructure/system';
import { pgClient, resetDatabase, testConfig } from '../support/database';
import { K, brl, buildServices, wagerCommand } from '../support/services';
import { collect, drain, testSqs } from '../support/sqs';

let orm: MikroORM;
let c: Client;
let sqs: SQSClient;
let eventsUrl: string;
let s: ReturnType<typeof buildServices>;
const ctx = { correlationId: 'corr-outbox' };
const options = { batchSize: 50, retryMaxSeconds: 300, lagAlertAttempts: 10 };

beforeAll(async () => {
  orm = await resetDatabase();
  c = await pgClient();
  const t = testSqs();
  sqs = t.client;
  eventsUrl = t.config.eventsQueueUrl;
  s = buildServices(orm);
});
beforeEach(async () => {
  // Isola os testes: publica/descarta pendências antigas e esvazia a fila.
  await c.query('UPDATE outbox_messages SET published_at = now() WHERE published_at IS NULL');
  await drain(sqs, eventsUrl);
});
afterAll(async () => {
  await c.end();
  await orm.close(true);
  sqs.destroy();
});

const publisher = (uow = s.uow, port: EventPublisherPort = new SqsEventPublisher(sqs, eventsUrl)) =>
  new PublishOutboxUseCase(uow, port, new SystemClock(), options);

async function pendingCount(): Promise<number> {
  const r = await c.query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM outbox_messages WHERE published_at IS NULL',
  );
  return Number.parseInt(r.rows[0]?.n ?? '0', 10);
}

describe('Outbox', () => {
  test('evento só existe se a transação comitar (atomicidade efeito + outbox)', async () => {
    const before = await pendingCount();
    const w = await s.createWallet.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('10.00') },
      ctx,
    );
    expect(await pendingCount()).toBe(before + 2);
    // Transação que grava evento e falha: nada sobra (nem evento, nem efeito).
    await s.uow
      .run(async (scope) => {
        const wallet = await scope.wallets.lockById(w.id);
        if (wallet === undefined) throw new Error('wallet');
        const { OutboxMessage } = await import('../../src/domain/messaging/outbox-message');
        const { WalletBalanceChanged } =
          await import('../../src/domain/shared/events/wager-events');
        const entry = wallet.credit({
          entryId: Bun.randomUUIDv7(),
          transactionId: Bun.randomUUIDv7(),
          money: brl('1.00'),
          at: new Date(),
        });
        await scope.outbox.enqueue(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, entry, {
              eventId: Bun.randomUUIDv7(),
              correlationId: 'x',
              occurredAt: new Date(),
            }),
          ),
        );
        throw new Error('rollback proposital');
      })
      .catch(() => undefined);
    expect(await pendingCount()).toBe(before + 2);
  });

  test('nada é publicado antes do worker rodar (Restrição #4); o worker publica e marca', async () => {
    const w = await s.createWallet.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('100.00') },
      ctx,
    );
    await s.submit.execute(wagerCommand(w, K.Bet, '10.00'), ctx);
    // Commit feito, worker ainda não rodou: fila vazia.
    expect(await drain(sqs, eventsUrl)).toHaveLength(0);

    const report = await publisher().execute();
    expect(report).toEqual({ published: 4, failed: 0, overdue: 0 });
    expect(await pendingCount()).toBe(0);

    const messages = await collect(sqs, eventsUrl, 4);
    expect(messages).toHaveLength(4);
    for (const m of messages) {
      const body = JSON.parse(m.Body ?? '{}') as {
        eventId: string;
        aggregateId: string;
        eventType: string;
      };
      expect(m.Attributes?.MessageGroupId).toBe(w.id);
      expect(m.Attributes?.MessageDeduplicationId).toBe(body.eventId);
      expect(body.aggregateId).toBe(w.id);
    }
    const types = messages.map(
      (m) => (JSON.parse(m.Body ?? '{}') as { eventType: string }).eventType,
    );
    expect(types.filter((t) => t === 'WalletBalanceChanged')).toHaveLength(2);
  });

  test('dois publishers concorrentes (instâncias distintas) sobre a mesma outbox: cada evento 1×', async () => {
    // 10 wallets × 2 eventos = 20 eventos pendentes
    for (let i = 0; i < 10; i++) {
      await s.createWallet.execute(
        { playerId: Bun.randomUUIDv7(), initialBalance: brl('1.00') },
        ctx,
      );
    }
    expect(await pendingCount()).toBe(20);

    // Segunda "instância": ORM e pool próprios.
    const orm2 = await createOrm(testConfig().database);
    try {
      const small = { ...options, batchSize: 3 };
      const p1 = new PublishOutboxUseCase(
        s.uow,
        new SqsEventPublisher(sqs, eventsUrl),
        new SystemClock(),
        small,
      );
      const p2 = new PublishOutboxUseCase(
        new MikroOrmUnitOfWork(orm2, 5000),
        new SqsEventPublisher(createSqsClient(testConfig().sqs), eventsUrl),
        new SystemClock(),
        small,
      );
      let total = 0;
      for (let round = 0; round < 10 && (await pendingCount()) > 0; round++) {
        const [a, b] = await Promise.all([p1.execute(), p2.execute()]);
        total += a.published + b.published;
      }
      expect(total).toBe(20);
      expect(await pendingCount()).toBe(0);
      const messages = await collect(sqs, eventsUrl, 20);
      const ids = messages.map((m) => (JSON.parse(m.Body ?? '{}') as { eventId: string }).eventId);
      expect(ids).toHaveLength(20);
      expect(new Set(ids).size).toBe(20);
    } finally {
      await orm2.close(true);
    }
  });

  test('crash entre publicar e marcar: republica com o mesmo eventId; FIFO deduplica', async () => {
    await s.createWallet.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('5.00') },
      ctx,
    );
    const real = new SqsEventPublisher(sqs, eventsUrl);
    // Publica de verdade e "morre" antes de confirmar: a transação da outbox não comita.
    const crashing: EventPublisherPort = {
      async publish(message: OutboxMessage) {
        await real.publish(message);
        throw new Error('processo morreu depois de publicar');
      },
    };
    const crashed = await publisher(s.uow, crashing).execute();
    expect(crashed.published).toBe(0);
    expect(await pendingCount()).toBe(2);

    // Outra instância assume (zera o backoff para não esperar no teste).
    await c.query('UPDATE outbox_messages SET next_attempt_at = now() WHERE published_at IS NULL');
    const recovered = await publisher().execute();
    expect(recovered.published).toBe(2);
    expect(await pendingCount()).toBe(0);

    // Publicado 2× com o mesmo MessageDeduplicationId: a fila entrega 1× cada.
    const messages = await collect(sqs, eventsUrl, 2, 3000);
    const ids = messages.map((m) => (JSON.parse(m.Body ?? '{}') as { eventId: string }).eventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(2);
  });

  test('SQS indisponível: nada é perdido; attempts++ e backoff; publica quando volta', async () => {
    await s.createWallet.execute(
      { playerId: Bun.randomUUIDv7(), initialBalance: brl('5.00') },
      ctx,
    );
    const down = new SqsEventPublisher(
      createSqsClient({ ...testConfig().sqs, endpoint: 'http://127.0.0.1:1' }),
      eventsUrl,
    );
    const report = await publisher(s.uow, down).execute();
    // O segundo evento da mesma wallet nem é tentado (ordem por aggregate).
    expect(report.failed).toBe(1);
    const rows = await c.query<{ attempts: number; last_error: string | null; delay: string }>(
      `SELECT attempts, last_error, EXTRACT(EPOCH FROM (next_attempt_at - now()))::int::text AS delay
         FROM outbox_messages WHERE published_at IS NULL ORDER BY attempts DESC`,
    );
    expect(rows.rows[0]?.attempts).toBe(1);
    expect(rows.rows[0]?.last_error).not.toBeNull();
    expect(Number.parseInt(rows.rows[0]?.delay ?? '-1', 10)).toBeGreaterThanOrEqual(0);

    await c.query('UPDATE outbox_messages SET next_attempt_at = now() WHERE published_at IS NULL');
    expect((await publisher().execute()).published).toBe(2);
    expect(await pendingCount()).toBe(0);
  });
});
