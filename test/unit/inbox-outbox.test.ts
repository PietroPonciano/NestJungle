import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { InvariantViolationError } from '../../src/domain/shared/domain-error';
import { WagerTransactionProcessed } from '../../src/domain/shared/events/wager-events';
import {
  T0,
  WagerTransactionKind as K,
  at,
  brl,
  id,
  newTx,
  openWallet,
} from '../support/factories';

function event() {
  const wallet = openWallet('100.00');
  const tx = newTx(wallet, K.Loss, '0.00');
  tx.markProcessed({ referenceTransactionId: undefined, observedBalance: brl('100.00'), at: T0 });
  return WagerTransactionProcessed.from(tx, { eventId: id(), correlationId: id(), occurredAt: T0 });
}

describe('OutboxMessage', () => {
  test('enqueue: id = eventId, payload = envelope, pendente e devido imediatamente', () => {
    const e = event();
    const m = OutboxMessage.enqueue(e);
    expect(m.id).toBe(e.eventId);
    expect(m.aggregateId).toBe(e.aggregateId);
    expect(m.eventType).toBe('WagerTransactionProcessed');
    expect(m.payload).toEqual(e.toJSON() as unknown as Record<string, unknown>);
    expect(m.attempts).toBe(0);
    expect(m.isPending()).toBe(true);
    expect(m.isDue(T0)).toBe(true);
  });

  test('scheduleRetry: backoff 1s, 2s, 4s ... com teto de 5 min, sem descartar', () => {
    const m = OutboxMessage.enqueue(event());
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      m.scheduleRetry(T0, 'sqs indisponível');
      delays.push((m.nextAttemptAt.getTime() - T0.getTime()) / 1000);
    }
    expect(delays).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300]);
    expect(m.attempts).toBe(12);
    expect(m.isPending()).toBe(true);
    expect(m.lastError).toBe('sqs indisponível');
    expect(m.isDue(at(299))).toBe(false);
    expect(m.isDue(at(300))).toBe(true);
  });

  test('markPublished uma única vez; depois não é pendente nem devido', () => {
    const m = OutboxMessage.enqueue(event());
    m.markPublished(at(1));
    expect(m.isPending()).toBe(false);
    expect(m.isDue(at(10))).toBe(false);
    expect(() => {
      m.markPublished(at(2));
    }).toThrow(InvariantViolationError);
    expect(() => {
      m.scheduleRetry(at(2));
    }).toThrow(InvariantViolationError);
  });
});

describe('InboxMessage', () => {
  const receive = () =>
    InboxMessage.receive({
      messageId: 'msg-123',
      consumerName: 'wager-transactions-consumer',
      payloadHash: 'h1',
      receivedAt: T0,
    });

  test('receive: não processada; markProcessed uma única vez', () => {
    const m = receive();
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(at(1));
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toEqual(at(1));
    expect(() => {
      m.markProcessed(at(2));
    }).toThrow(InvariantViolationError);
  });

  test('mesmo messageId com payload diferente é conflito', () => {
    expect(receive().matchesPayload('h1')).toBe(true);
    expect(receive().matchesPayload('h2')).toBe(false);
  });

  test('messageId e consumerName obrigatórios', () => {
    expect(() =>
      InboxMessage.receive({ messageId: ' ', consumerName: 'c', payloadHash: 'h', receivedAt: T0 }),
    ).toThrow(InvariantViolationError);
  });
});
