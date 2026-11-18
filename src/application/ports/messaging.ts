/** Portas de mensageria (implementadas sobre SQS na infraestrutura). */
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface EventPublisherPort {
  /**
   * Publica um evento de integração na fila de eventos de saída (D8).
   * Deve ser idempotente do ponto de vista do consumidor: a deduplicação usa
   * `message.id` (= eventId).
   */
  publish(message: OutboxMessage): Promise<void>;
}
