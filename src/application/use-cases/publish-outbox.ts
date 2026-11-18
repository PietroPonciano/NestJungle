/**
 * Use case: publicar um lote da outbox (Transactional Outbox, enunciado §11).
 *
 * Invariantes:
 *  - Restrição #4: este é o ÚNICO caminho de publicação. Só chegam aqui
 *    eventos de transações já comitadas (a linha da outbox só existe se o
 *    commit aconteceu).
 *  - Restrição #8: várias instâncias rodam isto ao mesmo tempo. O lote é
 *    reivindicado com FOR UPDATE SKIP LOCKED, então cada linha fica com no
 *    máximo um publisher por vez.
 *  - Nunca perde: em falha, scheduleRetry (backoff com teto) mantém a linha
 *    pendente. Se o processo morrer entre publicar e marcar, o rollback
 *    devolve a linha e outro publisher republica com o MESMO eventId
 *    (MessageDeduplicationId no FIFO + deduplicação por eventId no
 *    consumidor), o que é seguro.
 *  - Ordem por wallet: se um evento de um aggregate falhar, os seguintes do
 *    mesmo aggregate no lote não são publicados nesta rodada.
 *  - Os locks seguros durante a chamada ao SQS são só das linhas da outbox,
 *    nunca da wallet. As transações financeiras não esperam por isso.
 */
import type { EventPublisherPort } from '../ports/messaging';
import type { Clock } from '../ports/system';
import type { UnitOfWork } from '../ports/unit-of-work';

export interface OutboxPublishReport {
  published: number;
  failed: number;
  /** Mensagens que passaram do limite de tentativas (para alerta/métrica). */
  overdue: number;
}

export interface OutboxPublishOptions {
  batchSize: number;
  retryMaxSeconds: number;
  lagAlertAttempts: number;
}

export class PublishOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisherPort,
    private readonly clock: Clock,
    private readonly options: OutboxPublishOptions,
  ) {}

  async execute(): Promise<OutboxPublishReport> {
    return this.uow.run(async (scope) => {
      const now = this.clock.now();
      const batch = await scope.outbox.claimDue(now, this.options.batchSize);
      const report: OutboxPublishReport = { published: 0, failed: 0, overdue: 0 };
      const blockedAggregates = new Set<string>();

      for (const message of batch) {
        if (blockedAggregates.has(message.aggregateId)) continue;
        try {
          await this.publisher.publish(message);
          message.markPublished(this.clock.now());
          report.published += 1;
        } catch (error: unknown) {
          message.scheduleRetry(this.clock.now(), errorMessage(error), {
            baseDelayMs: 1000,
            maxDelayMs: this.options.retryMaxSeconds * 1000,
          });
          blockedAggregates.add(message.aggregateId);
          report.failed += 1;
          if (message.attempts >= this.options.lagAlertAttempts) report.overdue += 1;
        }
        await scope.outbox.save(message);
      }
      return report;
    });
  }
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 500);
}
