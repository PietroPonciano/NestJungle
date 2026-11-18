import type { EventContext } from '../../domain/shared/events/integration-event';
import type { IdGenerator } from '../ports/system';

/** Contexto de correlação de uma operação (HTTP: header; SQS: messageId). */
export interface OperationContext {
  correlationId: string;
  /** Id da mensagem/requisição que causou o efeito (ex.: messageId do SQS). */
  causationId?: string | undefined;
  /** Identidade autenticada (hoje sempre undefined: AuthGuard no-op). */
  principal?: string | undefined;
}

export function eventContext(ids: IdGenerator, ctx: OperationContext, at: Date): EventContext {
  return {
    eventId: ids.next(),
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: at,
  };
}
