/**
 * OutboxMessage — evento de integração aguardando publicação (Transactional Outbox).
 *
 * Invariantes:
 *  - Restrição #4: a mensagem é gravada na MESMA transação SQL do efeito
 *    financeiro e só é publicada pelo worker DEPOIS do commit. Se o commit
 *    falha, o evento nunca existiu.
 *  - id = eventId do envelope, o que dá deduplicação no consumidor e
 *    MessageDeduplicationId na fila FIFO.
 *  - Nunca é descartada: em falha, `scheduleRetry` incrementa attempts e
 *    reagenda com backoff exponencial (base 1 s, fator 2, teto 5 min). Depois
 *    de N tentativas uma métrica sinaliza o atraso, mas a mensagem continua
 *    pendente.
 *  - publishedAt é marcado uma única vez.
 */
import { InvariantViolationError } from '../shared/domain-error';
import type { IntegrationEvent } from '../shared/events/integration-event';

export interface OutboxRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_OUTBOX_RETRY: OutboxRetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60 * 1000,
};

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | undefined;
  lastError: string | undefined;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    // O envelope já é JSON puro (MoneyProps como string); congelado para a
    // linha gravada ser exatamente o que será publicado.
    const payload = Object.freeze({ ...event.toJSON() }) as Readonly<Record<string, unknown>>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      payload,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`Evento ${this.id} já publicado`);
    }
    this._publishedAt = at;
    this._lastError = undefined;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff exponencial com teto). */
  scheduleRetry(now: Date, error?: string, policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`Evento ${this.id} já publicado`);
    }
    this._attempts += 1;
    const exponential = policy.baseDelayMs * 2 ** Math.min(this._attempts - 1, 30);
    this._nextAttemptAt = new Date(now.getTime() + Math.min(exponential, policy.maxDelayMs));
    this._lastError = error;
  }
}
