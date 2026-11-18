/**
 * IntegrationEvent — envelope abstrato dos eventos de integração (enunciado §11).
 *
 * Invariantes:
 *  - `eventType` e `version` ficam NO TIPO (cada subclasse concreta os fixa),
 *    nunca numa string solta no call site.
 *  - `data` é JSON estável e versionável: valores monetários vão como
 *    MoneyProps (string decimal), nunca como instância de Money (Restrição #1).
 *  - `eventId` é a chave de deduplicação: vira o id da linha na outbox e o
 *    MessageDeduplicationId na fila de eventos. Publicação duplicada é segura
 *    porque o consumidor deduplica por eventId.
 *  - Imutável depois de criado.
 *  - Restrição #4: criar um evento NÃO o publica. O use case o grava na outbox,
 *    na mesma transação SQL do efeito, e só o worker publica após o commit.
 */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  data: T;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  /** Envelope serializado gravado no payload da outbox. */
  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
