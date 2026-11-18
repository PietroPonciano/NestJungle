/** LocalStack SQS REAL para testes (nada de mock). */
import {
  DeleteMessageBatchCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs';
import { testConfig } from './database';

export function testSqs(): { client: SQSClient; config: ReturnType<typeof testConfig>['sqs'] } {
  const config = testConfig().sqs;
  return { client: createSqsClient(config), config };
}

/** Recebe e apaga tudo que estiver visível na fila (isola os testes). */
export async function drain(client: SQSClient, queueUrl: string): Promise<Message[]> {
  const all: Message[] = [];
  for (;;) {
    const r = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    const messages = r.Messages ?? [];
    if (messages.length === 0) return all;
    all.push(...messages);
    await client.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle ?? '' })),
      }),
    );
  }
}

/** Recebe até `expected` mensagens (ou o prazo acabar), apagando-as. */
export async function collect(
  client: SQSClient,
  queueUrl: string,
  expected: number,
  timeoutMs = 10_000,
): Promise<Message[]> {
  const deadline = Date.now() + timeoutMs;
  const all: Message[] = [];
  while (all.length < expected && Date.now() < deadline) {
    all.push(...(await drain(client, queueUrl)));
    if (all.length < expected) await Bun.sleep(100);
  }
  return all;
}

/** Mensagens visíveis + em voo (sem consumir nada). 0 = tudo foi apagado (ack). */
export async function queueDepth(client: SQSClient, queueUrl: string): Promise<number> {
  const { GetQueueAttributesCommand } = await import('@aws-sdk/client-sqs');
  const r = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  const visible = Number.parseInt(r.Attributes?.ApproximateNumberOfMessages ?? '0', 10);
  const inFlight = Number.parseInt(r.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0', 10);
  return visible + inFlight;
}
