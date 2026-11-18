import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../src/domain/shared/domain-error';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../src/domain/shared/events/wager-events';
import { FailureCode } from '../../src/domain/wager-transaction/failure-code';
import {
  DEFAULT_PENDING_REFERENCE_POLICY,
  PendingReferencePolicy,
} from '../../src/domain/wager-transaction/pending-reference-policy';
import { settle } from '../../src/domain/wager-transaction/wager-settlement';
import { T0, WagerTransactionKind as K, at, id, newTx, openWallet } from '../support/factories';

const ctx = () => ({ eventId: id(), correlationId: id(), causationId: 'msg-1', occurredAt: at(1) });
const policy = new PendingReferencePolicy(DEFAULT_PENDING_REFERENCE_POLICY);

function processedBet() {
  const wallet = openWallet('100.00');
  const tx = newTx(wallet, K.Bet, '80.00');
  const { ledgerEntry } = settle({
    wallet,
    transaction: tx,
    reference: undefined,
    referenceAlreadyReversed: false,
    ledgerEntryId: id(),
    policy,
    at: at(1),
  });
  if (ledgerEntry === undefined) throw new Error('esperado lançamento');
  return { wallet, tx, ledgerEntry };
}

describe('IntegrationEvent — envelope', () => {
  test('WalletBalanceChanged: envelope do enunciado, com MoneyProps e eventType/version no tipo', () => {
    const { wallet, ledgerEntry } = processedBet();
    const c = ctx();
    // Compara o JSON efetivamente serializado (o que vai para a outbox/fila).
    const json: unknown = JSON.parse(
      JSON.stringify(WalletBalanceChanged.from(wallet, ledgerEntry, c)),
    );
    expect(json).toEqual({
      eventId: c.eventId,
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: c.correlationId,
      causationId: 'msg-1',
      occurredAt: '2026-07-29T15:00:01.000Z',
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: ledgerEntry.transactionId,
        direction: 'DEBIT',
        money: { amount: '80.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '20.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('payload é JSON puro e estável (sem instâncias de Money)', () => {
    const { tx } = processedBet();
    const json = WagerTransactionProcessed.from(tx, ctx()).toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(json.data.money).toEqual({ amount: '80.00', currency: 'BRL' });
    expect(json.data.referenceTransactionId).toBeNull();
  });

  test('causationId omitido quando ausente', () => {
    const { tx } = processedBet();
    const json = WagerTransactionProcessed.from(tx, {
      eventId: id(),
      correlationId: id(),
      occurredAt: T0,
    }).toJSON();
    expect('causationId' in json).toBe(false);
  });

  test('data é imutável', () => {
    const { tx } = processedBet();
    const event = WagerTransactionProcessed.from(tx, ctx());
    expect(Object.isFrozen(event.data)).toBe(true);
  });
});

describe('Eventos exigem o estado correspondente', () => {
  test('Processed só de PROCESSED; Rejected só de REJECTED; PendingReference só de PENDING_REFERENCE', () => {
    const wallet = openWallet('100.00');
    const pending = newTx(wallet, K.Bet, '1.00');
    expect(() => WagerTransactionProcessed.from(pending, ctx())).toThrow(InvariantViolationError);
    expect(() => WagerTransactionRejected.from(pending, ctx())).toThrow(InvariantViolationError);
    expect(() => WagerTransactionPendingReference.from(pending, ctx())).toThrow(
      InvariantViolationError,
    );
  });

  test('Rejected carrega failureCode', () => {
    const wallet = openWallet('10.00');
    const tx = newTx(wallet, K.Bet, '80.00');
    tx.reject(FailureCode.InsufficientFunds, { observedBalance: wallet.balance, at: at(1) });
    const json = WagerTransactionRejected.from(tx, ctx()).toJSON();
    expect(json.eventType).toBe('WagerTransactionRejected');
    expect<string>(json.data.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(json.aggregateId).toBe(wallet.id);
  });

  test('PendingReference carrega referência e expiresAt ISO', () => {
    const wallet = openWallet('10.00');
    const tx = newTx(wallet, K.Refund, '5.00', { referenceExternalTransactionId: 'bet-9' });
    tx.markPendingReference(policy.initial(T0), T0);
    const json = WagerTransactionPendingReference.from(tx, ctx()).toJSON();
    expect(json.data.referenceExternalTransactionId).toBe('bet-9');
    expect(json.data.expiresAt).toBe('2026-07-29T16:00:00.000Z');
  });

  test('WalletBalanceChanged rejeita lançamento de outra wallet', () => {
    const { ledgerEntry } = processedBet();
    expect(() => WalletBalanceChanged.from(openWallet('1.00'), ledgerEntry, ctx())).toThrow(
      InvariantViolationError,
    );
  });
});
