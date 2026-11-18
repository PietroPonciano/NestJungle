/**
 * InboxMessage — deduplicação persistente do consumidor SQS.
 *
 * Invariantes:
 *  - Restrição #2: a deduplicação é PERSISTENTE (tabela inbox_messages, PK
 *    (consumer_name, message_id)), nunca um cache em memória.
 *  - Gravada na MESMA transação SQL do efeito financeiro: se o commit falhar,
 *    a inbox também não existe e a redelivery reprocessa; se o commit passar e
 *    o processo morrer antes do ack, a redelivery encontra a inbox e só dá ack.
 *  - Mesmo messageId com payloadHash diferente é conflito, não replay.
 *  - processedAt só é marcado uma vez.
 */
import { InvariantViolationError } from '../shared/domain-error';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (props.messageId.trim() === '' || props.consumerName.trim() === '') {
      throw new InvariantViolationError('messageId e consumerName são obrigatórios');
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvariantViolationError(`Mensagem ${this.messageId} já processada`);
    }
    this._processedAt = at;
  }
}
