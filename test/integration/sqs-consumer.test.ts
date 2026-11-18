/**
 * Etapa 13 — consumidor SQS com inbox sobre LocalStack e PostgreSQL REAIS.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ReceiveMessageCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { SubmitWagerTransactionUseCase } from '../../src/application/use-cases/submit-wager-transaction';
import type { AppConfig } from '../../src/infrastructure/config/app-config';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { parseWagerMessage } from '../../src/interfaces/messaging/wager-message';
import { JsonLogger } from '../../src/shared/logger';
import { pgClient, resetDatabase } from '../support/database';
import { assertLedgerInvariants } from '../support/invariants';
import { brl, buildServices } from '../support/services';
import { drain, queueDepth, testSqs } from '../support/sqs';

let orm: MikroORM;
let c: Client;
let sqs: SQSClient;
let cfg: AppConfig['sqs'];
let s: ReturnType<typeof buildServices>;
let consumer: SqsWagerConsumer;
const retries = { count: 0 };
const dlqReasons: string[] = [];
const logger = new JsonLogger('error');

beforeAll(async () => {
  orm = await resetDatabase();
  c = await pgClient();
  const t = testSqs();
  sqs = t.client;
  cfg = { ...t.config, waitTimeSeconds: 1, retryBaseSeconds: 1, retryMaxSeconds: 2 };
  s = buildServices(orm);
  // lock_timeout curto: espera por lock vira transitório rapidamente.
  const submit = new SubmitWagerTransactionUseCase(
    new MikroOrmUnitOfWork(orm, 300),
    s.ids,
    s.clock,
    s.policy,
  );
  consumer = new SqsWagerConsumer(sqs, cfg, submit, logger, {
    onRetry: () => {
      retries.count += 1;
    },
    onDeadLetter: (reason) => {
      dlqReasons.push(reason);
    },
    onProcessingTime: () => undefined,
  });
});
beforeEach(async () => {
  await drain(sqs, cfg.transactionsQueueUrl);
  await drain(sqs, cfg.transactionsDlqUrl);
  retries.count = 0;
  dlqReasons.length = 0;
});
afterEach(async () => {
  await consumer.stop();
  await assertLedgerInvariants(c);
});
afterAll(async () => {
  await c.end();
  await orm.close(true);
  sqs.destroy();
});

const wallet = (initial: string) =>
  s.createWallet.execute(
    { playerId: Bun.randomUUIDv7(), initialBalance: brl(initial) },
    { correlationId: 't' },
  );

function body(
  w: { id: string; playerId: string },
  over: Record<string, unknown> = {},
  messageId = `msg-${Bun.randomUUIDv7()}`,
) {
  const ext = `tx-${Bun.randomUUIDv7()}`;
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: ext,
      idempotencyKey: `provider-a:${ext}`,
      playerId: w.playerId,
      walletId: w.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...over,
    },
  };
}

async function send(
  payload: unknown,
  groupId: string,
  dedupId = Bun.randomUUIDv7(),
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: cfg.transactionsQueueUrl,
      MessageBody: JSON.stringify(payload),
      MessageGroupId: groupId,
      MessageDeduplicationId: dedupId,
    }),
  );
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error('condição não atingida no prazo');
}

async function txCount(walletId: string, where = "kind <> 'OPENING'"): Promise<number> {
  const r = await c.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM wager_transactions WHERE wallet_id = $1 AND ${where}`,
    [walletId],
  );
  return Number.parseInt(r.rows[0]?.n ?? '0', 10);
}

async function balance(walletId: string): Promise<string> {
  const r = await c.query<{ b: string }>('SELECT balance::text AS b FROM wallets WHERE id = $1', [
    walletId,
  ]);
  return r.rows[0]?.b ?? '';
}

describe('Consumidor SQS', () => {
  test('processa a mensagem com o mesmo use case, grava inbox e dá ack após o commit', async () => {
    const w = await wallet('100.00');
    const msg = body(w);
    await send(msg, w.id);
    consumer.start();
    await waitFor(async () => (await txCount(w.id)) === 1);
    await consumer.stop();
    expect(await balance(w.id)).toBe('90.00');
    const inbox = await c.query('SELECT processed_at FROM inbox_messages WHERE message_id = $1', [
      msg.messageId,
    ]);
    expect(inbox.rowCount).toBe(1);
    expect(await drain(sqs, cfg.transactionsQueueUrl)).toHaveLength(0);
  });

  test('redelivery (mesmo messageId, dedup SQS diferente — Restrição #3): 1 efeito, ambos ack', async () => {
    const w = await wallet('100.00');
    const msg = body(w);
    // Dedup ids distintos (e únicos por execução: o FIFO lembra ids por 5 min).
    await send(msg, w.id, `${msg.messageId}-a`);
    await send(msg, w.id, `${msg.messageId}-b`);
    consumer.start();
    // Ambas as entregas confirmadas (apagadas) e um único efeito.
    await waitFor(async () => (await queueDepth(sqs, cfg.transactionsQueueUrl)) === 0);
    await consumer.stop();
    expect(await txCount(w.id)).toBe(1);
    expect(await balance(w.id)).toBe('90.00');
  });

  test('mesma operação em messageIds diferentes: banco garante 1 efeito', async () => {
    const w = await wallet('100.00');
    const msg = body(w);
    await send(msg, w.id);
    await send({ ...msg, messageId: `${msg.messageId}-bis` }, w.id);
    consumer.start();
    await waitFor(async () => {
      const r = await c.query('SELECT 1 FROM inbox_messages WHERE message_id LIKE $1', [
        `${msg.messageId}%`,
      ]);
      return r.rowCount === 2;
    });
    await consumer.stop();
    expect(await txCount(w.id)).toBe(1);
    expect(await balance(w.id)).toBe('90.00');
  });

  test('rejeição de negócio: REJECTED gravado e ack (não vai à DLQ)', async () => {
    const w = await wallet('5.00');
    await send(body(w), w.id);
    consumer.start();
    await waitFor(async () => (await txCount(w.id, "status = 'REJECTED'")) === 1);
    await consumer.stop();
    expect(dlqReasons).toEqual([]);
    expect(await drain(sqs, cfg.transactionsDlqUrl)).toHaveLength(0);
  });

  test('payload inválido: DLQ explícita, sem linha de transação (D7)', async () => {
    const w = await wallet('100.00');
    const invalid = body(w, { money: { amount: 10, currency: 'BRL' } });
    await send(invalid, w.id);
    consumer.start();
    await waitFor(() => Promise.resolve(dlqReasons.length === 1));
    await consumer.stop();
    expect(dlqReasons).toEqual(['INVALID_PAYLOAD']);
    expect(await txCount(w.id)).toBe(0);
    const dlq = await drain(sqs, cfg.transactionsDlqUrl);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.MessageAttributes?.failureReason?.StringValue).toBe('INVALID_PAYLOAD');
  });

  test('wallet inexistente: DLQ, sem linha', async () => {
    const ghost = { id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() };
    await send(body(ghost), ghost.id);
    consumer.start();
    await waitFor(() => Promise.resolve(dlqReasons.length === 1));
    await consumer.stop();
    expect(dlqReasons).toEqual(['WALLET_NOT_FOUND']);
    const r = await c.query('SELECT 1 FROM wager_transactions WHERE wallet_id = $1', [ghost.id]);
    expect(r.rowCount).toBe(0);
  });

  test('transitório (lock da wallet seguro por outra conexão): sem ack, retry com backoff, depois processa 1×', async () => {
    const w = await wallet('100.00');
    const holder = await pgClient();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM wallets WHERE id = $1 FOR UPDATE', [w.id]);
    await send(body(w), w.id);
    consumer.start();
    await waitFor(() => Promise.resolve(retries.count >= 1));
    expect(await txCount(w.id)).toBe(0); // transitório nunca vira status (D7)
    await holder.query('ROLLBACK');
    await holder.end();
    await waitFor(async () => (await txCount(w.id)) === 1);
    await consumer.stop();
    expect(await balance(w.id)).toBe('90.00');
  });

  test('worker morreu depois do commit e antes do ack: redelivery vira replay (inbox)', async () => {
    const w = await wallet('100.00');
    const msg = body(w);
    await send(msg, w.id);
    // "Worker A": recebe e comita, mas morre antes de apagar a mensagem.
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: cfg.transactionsQueueUrl,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 1,
      }),
    );
    expect(received.Messages).toHaveLength(1);
    const parsed = parseWagerMessage(received.Messages?.[0]?.Body);
    await s.submit.execute(
      parsed.command,
      { correlationId: parsed.messageId },
      {
        consumerName: cfg.consumerName,
        messageId: parsed.messageId,
        payloadHash: parsed.payloadHash,
      },
    );
    expect(await balance(w.id)).toBe('90.00');

    // "Worker B": recebe a redelivery após o visibility timeout.
    consumer.start();
    // A redelivery foi recebida pelo consumidor e confirmada (ack) sem novo efeito.
    await waitFor(async () => (await queueDepth(sqs, cfg.transactionsQueueUrl)) === 0);
    await consumer.stop();
    expect(await txCount(w.id)).toBe(1);
    expect(await balance(w.id)).toBe('90.00');
  });

  test('SIGTERM (stop): nenhuma mensagem perdida; ao religar, cada uma processada 1×', async () => {
    const w = await wallet('100.00');
    for (let i = 0; i < 5; i++)
      await send(body(w, { money: { amount: '1.00', currency: 'BRL' } }), w.id);
    consumer.start();
    await Bun.sleep(300);
    await consumer.stop();
    consumer.start();
    await waitFor(async () => (await txCount(w.id)) === 5);
    await Bun.sleep(1500);
    await consumer.stop();
    expect(await txCount(w.id)).toBe(5);
    expect(await balance(w.id)).toBe('95.00');
  });

  test('última tentativa com erro transitório: FAILED RETRY_LIMIT_EXCEEDED auditável + DLQ (E4)', async () => {
    const w = await wallet('100.00');
    const bet = body(w);
    await send(bet, w.id);
    consumer.start();
    await waitFor(async () => (await txCount(w.id)) === 1);
    await consumer.stop();

    // A referência (BET) fica travada por outra conexão: o REFUND não consegue
    // o lock da referência (transitório), mas o registro do FAILED só precisa
    // da wallet.
    const holder = await pgClient();
    await holder.query('BEGIN');
    await holder.query(
      'SELECT 1 FROM wager_transactions WHERE external_transaction_id = $1 FOR UPDATE',
      [bet.data.externalTransactionId],
    );
    try {
      await send(
        body(w, { kind: 'REFUND', referenceExternalTransactionId: bet.data.externalTransactionId }),
        w.id,
      );
      const received = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: cfg.transactionsQueueUrl,
          WaitTimeSeconds: 2,
          MessageSystemAttributeNames: ['All'],
        }),
      );
      const message = received.Messages?.[0];
      if (message === undefined) throw new Error('mensagem não recebida');
      // Simula a 5ª entrega (maxReceiveCount) sem esperar 5 backoffs reais.
      message.Attributes = {
        ...message.Attributes,
        ApproximateReceiveCount: String(cfg.maxReceiveCount),
      };
      await consumer.handle(message);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect(dlqReasons).toEqual(['RETRY_LIMIT_EXCEEDED']);
    expect(await txCount(w.id, "status = 'FAILED' AND failure_code = 'RETRY_LIMIT_EXCEEDED'")).toBe(
      1,
    );
    expect(await balance(w.id)).toBe('90.00');
  });
});
