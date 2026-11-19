/**
 * Consumidor da fila wager-transactions.fifo (enunciado §10; guia §8.4).
 *
 * Garantias:
 *  - Mesmo use case da entrada HTTP; deduplicação pela inbox persistente,
 *    dentro da MESMA transação do efeito.
 *  - Ack (DeleteMessage) SOMENTE depois do commit. Se o processo morrer entre
 *    o commit e o ack, a redelivery encontra a inbox/transação e vira replay,
 *    sem duplicar o efeito.
 *  - O SQS não tem NACK: retry = não apagar + ChangeMessageVisibility com
 *    backoff exponencial e jitter (base 5 s, teto 5 min).
 *  - Classificação:
 *      negócio (REJECTED) e replay          -> ack
 *      transitório                          -> sem ack; retry com backoff;
 *                                              na última tentativa, DLQ explícita
 *                                              com motivo RETRY_LIMIT_EXCEEDED (E4),
 *                                              SEM gravar nada (D7: a key fica livre)
 *                                              (limite = maxReceiveCount da
 *                                              RedrivePolicy da fila)
 *      payload inválido / wallet inexistente
 *      / conflito de idempotência ou inbox  -> DLQ explícita + ack (sem linha)
 *      FAILED (erro permanente gravado)     -> DLQ explícita + ack
 *  - Mensagens processadas em sequência dentro do lote: o FIFO entrega em
 *    ordem por MessageGroupId (= walletId). Várias instâncias dividem os
 *    grupos entre si. Se uma mensagem vai a retry, as seguintes do MESMO grupo
 *    no lote são devolvidas sem processar (a ordem por wallet se mantém).
 *  - SIGTERM (stop): para de buscar, conclui a mensagem em andamento (commit +
 *    ack) e devolve a visibilidade (timeout 0) das que ainda não começaram.
 */
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  ApplicationError,
  IdempotencyConflictError,
  InboxConflictError,
  InvalidPayloadError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../application/errors';
import type { SubmitWagerTransactionUseCase } from '../../application/use-cases/submit-wager-transaction';
import { FailureCode } from '../../domain/wager-transaction/failure-code';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-kind';
import { parseWagerMessage, peekMessageId } from '../../interfaces/messaging/wager-message';
import type { AppLogger } from '../../shared/logger';
import type { AppConfig } from '../config/app-config';
import { parseRedriveMaxReceiveCount } from './redrive-policy';

export interface ConsumerObserver {
  onRetry(): void;
  onDeadLetter(reason: string): void;
  onProcessingTime(seconds: number): void;
}

const NOOP_OBSERVER: ConsumerObserver = {
  onRetry: () => undefined,
  onDeadLetter: () => undefined,
  onProcessingTime: () => undefined,
};

export type Disposition =
  | { type: 'ack' }
  | { type: 'retry'; delaySeconds: number }
  | { type: 'dead-letter'; reason: string };

export class SqsWagerConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  /**
   * Limite de entregas antes da DLQ. Começa com SQS_MAX_RECEIVE_COUNT e passa a
   * ser o maxReceiveCount da RedrivePolicy da fila assim que ela é lida.
   */
  private maxReceiveCount: number;
  private redriveSynced = false;

  constructor(
    private readonly sqs: SQSClient,
    private readonly config: AppConfig['sqs'],
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly logger: AppLogger,
    private readonly observer: ConsumerObserver = NOOP_OBSERVER,
    private readonly faults: AppConfig['faults'] = { crashAfterCommitBeforeAck: false },
  ) {
    this.maxReceiveCount = config.maxReceiveCount;
  }

  /** Limite em uso (exposto para testes e diagnóstico). */
  get effectiveMaxReceiveCount(): number {
    return this.maxReceiveCount;
  }

  /**
   * Alinha o limite de tentativas com a RedrivePolicy da fila (fonte da verdade
   * do enunciado §10). Sem isso, SQS_MAX_RECEIVE_COUNT pode divergir da fila:
   * menor, um erro transitório iria à DLQ enquanto a fila ainda tentaria de
   * novo; maior, a DLQ explícita com motivo (E4) nunca rodaria.
   * Se a fila não puder ser consultada, mantém o valor atual e o laço tenta de
   * novo na próxima volta.
   */
  async syncRedrivePolicy(): Promise<void> {
    let raw: string | undefined;
    try {
      const response = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.config.transactionsQueueUrl,
          AttributeNames: ['RedrivePolicy'],
        }),
      );
      raw = response.Attributes?.RedrivePolicy;
    } catch (error: unknown) {
      this.logger.warn('não foi possível ler a RedrivePolicy da fila; mantendo o limite atual', {
        maxReceiveCount: this.maxReceiveCount,
        error: String(error),
      });
      return;
    }
    this.redriveSynced = true;
    const fromQueue = parseRedriveMaxReceiveCount(raw);
    if (fromQueue === undefined) {
      this.logger.warn('fila sem RedrivePolicy válida; usando SQS_MAX_RECEIVE_COUNT', {
        maxReceiveCount: this.maxReceiveCount,
      });
      return;
    }
    if (fromQueue !== this.config.maxReceiveCount) {
      this.logger.warn('SQS_MAX_RECEIVE_COUNT difere da RedrivePolicy da fila; usando a fila', {
        configured: this.config.maxReceiveCount,
        queue: fromQueue,
      });
    }
    this.maxReceiveCount = fromQueue;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.pollLoop();
  }

  /**
   * SIGTERM: termina a mensagem atual e devolve as não iniciadas.
   * O long poll em andamento NÃO é abortado: abortar só do lado do cliente
   * deixa a requisição viva no servidor, e ela pode "receber" mensagens que
   * ninguém processa (ficam invisíveis até o visibility timeout). Esperamos ele
   * terminar (no máximo WaitTimeSeconds) e devolvemos o que chegar.
   */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private isRunning(): boolean {
    return this.running;
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      if (!this.redriveSynced) await this.syncRedrivePolicy();
      let messages: Message[];
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.config.transactionsQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.config.waitTimeSeconds, // long polling
            VisibilityTimeout: this.config.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
        );
        messages = response.Messages ?? [];
      } catch (error: unknown) {
        this.logger.warn('falha ao receber da fila; tentando de novo', { error: String(error) });
        await Bun.sleep(1000);
        continue;
      }

      // Grupos FIFO com uma mensagem em retry neste lote: as seguintes do mesmo
      // grupo NÃO são processadas antes dela (preserva a ordem por wallet).
      // Ficam invisíveis um pouco além do backoff da mensagem em retry, para que
      // ela reapareça primeiro mesmo onde o FIFO não retém o grupo (LocalStack).
      const blockedGroups = new Map<string, number>();
      for (const [index, message] of messages.entries()) {
        // Método (e não o campo) porque stop() pode ter mudado o estado durante o await.
        if (!this.isRunning()) {
          // Shutdown: devolve imediatamente as mensagens que não começaram.
          await this.releaseAll(messages.slice(index));
          break;
        }
        const group = message.Attributes?.MessageGroupId;
        const blockedFor = group === undefined ? undefined : blockedGroups.get(group);
        if (blockedFor !== undefined) {
          await this.releaseAll([message], blockedFor + 1);
          continue;
        }
        const outcome = await this.handle(message);
        if (outcome.type === 'retry' && group !== undefined) {
          blockedGroups.set(group, outcome.delaySeconds);
        }
      }
    }
  }

  /** Processa uma mensagem e devolve o destino dado a ela. Público para os testes. */
  async handle(message: Message): Promise<Disposition> {
    const started = performance.now();
    const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
    // No SQS o messageId é também o correlationId (propagado para os eventos).
    const messageId = peekMessageId(message.Body);
    const sqsLog = this.logger.child({ correlationId: messageId, messageId, receiveCount });
    let disposition: Disposition;

    try {
      const { command, messageId, payloadHash } = parseWagerMessage(message.Body);
      const outcome = await this.submit.execute(
        command,
        { correlationId: messageId, causationId: messageId },
        { consumerName: this.config.consumerName, messageId, payloadHash },
      );
      sqsLog.info('mensagem processada', {
        transactionId: outcome.result.transactionId,
        walletId: command.walletId,
        providerId: command.providerId,
        status: outcome.result.status,
        failureCode: outcome.result.failureCode,
        idempotentReplay: outcome.result.idempotentReplay,
        duplicateMessage: outcome.duplicateMessage,
      });
      disposition =
        outcome.result.status === WagerTransactionStatus.Failed
          ? { type: 'dead-letter', reason: outcome.result.failureCode ?? 'FAILED' }
          : { type: 'ack' };
    } catch (error: unknown) {
      disposition = this.classify(error, receiveCount, sqsLog);
    }

    await this.apply(message, disposition, sqsLog);
    this.observer.onProcessingTime((performance.now() - started) / 1000);
    return disposition;
  }

  private classify(error: unknown, receiveCount: number, log: AppLogger): Disposition {
    if (error instanceof TransientInfrastructureError) {
      if (receiveCount >= this.maxReceiveCount) {
        // E4: última tentativa permitida. Vai à DLQ com o motivo, mas NADA é
        // gravado (D7): a condição é transitória, então a idempotency key fica
        // livre. Um redrive da DLQ ou um retry do provedor (HTTP/fila) com a
        // mesma key processa normalmente quando a infraestrutura voltar.
        log.error('tentativas esgotadas por erro transitório; enviando à DLQ', {
          error: error.message,
        });
        return { type: 'dead-letter', reason: FailureCode.RetryLimitExceeded };
      }
      log.warn('erro transitório; mensagem volta para a fila', { error: error.message });
      return { type: 'retry', delaySeconds: this.backoffSeconds(receiveCount) };
    }
    if (
      error instanceof InvalidPayloadError ||
      error instanceof WalletNotFoundError ||
      error instanceof IdempotencyConflictError ||
      error instanceof InboxConflictError
    ) {
      log.warn('mensagem permanentemente inválida; enviando à DLQ', { code: error.code });
      return { type: 'dead-letter', reason: error.code };
    }
    if (error instanceof ApplicationError) {
      return { type: 'dead-letter', reason: error.code };
    }
    // Inesperado fora do use case (que já converte inesperados em FAILED):
    // tratamos como transitório. A redrive limita as tentativas.
    log.error('erro inesperado no consumidor', { error: String(error) });
    return { type: 'retry', delaySeconds: this.backoffSeconds(receiveCount) };
  }

  private async apply(message: Message, disposition: Disposition, log: AppLogger): Promise<void> {
    try {
      switch (disposition.type) {
        case 'ack':
          if (this.faults.crashAfterCommitBeforeAck) {
            // Injeção de falha (só em teste): o commit já aconteceu e o processo
            // morre antes do ack. A redelivery precisa ser absorvida pela inbox.
            log.warn('FAULT: matando o processo depois do commit e antes do ack');
            process.kill(process.pid, 'SIGKILL');
          }
          // Ack SÓ depois do commit (o use case já retornou = já comitou).
          await this.delete(message);
          return;
        case 'retry':
          this.observer.onRetry();
          await this.sqs.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.config.transactionsQueueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: disposition.delaySeconds,
            }),
          );
          return;
        case 'dead-letter':
          // DLQ primeiro, ack depois. Se morrer no meio, a redelivery reenvia
          // à DLQ com o mesmo MessageDeduplicationId (o FIFO deduplica).
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: this.config.transactionsDlqUrl,
              MessageBody: message.Body ?? '',
              MessageGroupId: message.Attributes?.MessageGroupId ?? 'unknown',
              MessageDeduplicationId: message.MessageId ?? crypto.randomUUID(),
              MessageAttributes: {
                failureReason: { DataType: 'String', StringValue: disposition.reason },
              },
            }),
          );
          this.observer.onDeadLetter(disposition.reason);
          await this.delete(message);
          return;
      }
    } catch (error: unknown) {
      // Falhar no ack/DLQ não perde nada: a mensagem reaparece após o
      // visibility timeout e a inbox absorve o reprocessamento.
      log.error('falha ao confirmar mensagem no SQS', {
        error: String(error),
        disposition: disposition.type,
      });
    }
  }

  private async delete(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.config.transactionsQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async releaseAll(messages: Message[], visibilityTimeout = 0): Promise<void> {
    await Promise.all(
      messages.map((m) =>
        this.sqs
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.config.transactionsQueueUrl,
              ReceiptHandle: m.ReceiptHandle,
              VisibilityTimeout: visibilityTimeout,
            }),
          )
          .catch(() => undefined),
      ),
    );
  }

  /** Backoff exponencial com jitter: base·2^(n-1) + [0, base), teto max. */
  private backoffSeconds(receiveCount: number): number {
    const base = this.config.retryBaseSeconds;
    const exponential = base * 2 ** Math.max(0, Math.min(receiveCount - 1, 20));
    const jitter = Math.floor(Math.random() * base);
    return Math.min(exponential + jitter, this.config.retryMaxSeconds);
  }
}
