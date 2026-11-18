/**
 * Cliente SQS e publisher de eventos (fila wager-events.fifo — D8).
 *
 * FIFO: MessageGroupId = aggregateId (ordem por wallet, paralelismo entre
 * wallets); MessageDeduplicationId = eventId (republicação após crash dentro da
 * janela de 5 min é descartada pelo SQS). Fora da janela, quem protege é a
 * deduplicação por eventId no consumidor (Restrição #3: FIFO é otimização).
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { EventPublisherPort } from '../../application/ports/messaging';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { AppConfig } from '../config/app-config';

/**
 * `requestTimeoutMs` padrão curto: publicação e ack não devem segurar
 * transações. O consumidor usa um cliente PRÓPRIO, com timeout maior que o long
 * poll (`consumerSqsClient`). Se o cliente desistisse antes do servidor
 * responder, a requisição continuaria viva no SQS e poderia "receber"
 * mensagens que ninguém processa (ficam invisíveis até o visibility timeout).
 */
export function createSqsClient(config: AppConfig['sqs'], requestTimeoutMs = 5_000): SQSClient {
  return new SQSClient({
    region: config.region,
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestHandler: { requestTimeout: requestTimeoutMs, connectionTimeout: 2_000 },
    maxAttempts: 2,
  });
}

export function consumerSqsClient(config: AppConfig['sqs']): SQSClient {
  return createSqsClient(config, (config.waitTimeSeconds + 10) * 1000);
}

export class SqsEventPublisher implements EventPublisherPort {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }
}

/**
 * Decorator de observabilidade: loga cada evento publicado com eventId,
 * eventType, walletId e correlationId. Liga a requisição/mensagem de origem ao
 * evento na fila de saída. Não loga o payload (enunciado §12).
 */
export class LoggingEventPublisher implements EventPublisherPort {
  constructor(
    private readonly inner: EventPublisherPort,
    private readonly logger: {
      info(msg: string, fields: Record<string, string | undefined>): void;
    },
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.inner.publish(message);
    const correlationId = message.payload.correlationId;
    this.logger.info('evento publicado', {
      eventId: message.id,
      eventType: message.eventType,
      walletId: message.aggregateId,
      correlationId: typeof correlationId === 'string' ? correlationId : undefined,
    });
  }
}
