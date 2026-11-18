import { describe, expect, test } from 'bun:test';
import {
  InvalidTransactionStateError,
  InvariantViolationError,
} from '../../src/domain/shared/domain-error';
import { FailureCode } from '../../src/domain/wager-transaction/failure-code';
import {
  DEFAULT_PENDING_REFERENCE_POLICY,
  PendingReferencePolicy,
} from '../../src/domain/wager-transaction/pending-reference-policy';
import { WagerTransaction } from '../../src/domain/wager-transaction/wager-transaction';
import { WagerTransactionStatus as S } from '../../src/domain/wager-transaction/wager-transaction-kind';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction';
import {
  T0,
  WagerTransactionKind as K,
  at,
  brl,
  id,
  newTx,
  openWallet,
} from '../support/factories';

const wallet = openWallet('100.00');
const policy = new PendingReferencePolicy(DEFAULT_PENDING_REFERENCE_POLICY);
const bal = brl('100.00');

const pending = (kind: K = K.Bet) =>
  newTx(wallet, kind, '10.00', {
    referenceExternalTransactionId: kind === K.Refund || kind === K.Rollback ? 'bet-1' : undefined,
  });
const pendingRef = () => {
  const tx = pending(K.Refund);
  tx.markPendingReference(policy.initial(T0), T0);
  return tx;
};
const processed = () => {
  const tx = pending();
  tx.markProcessed({ referenceTransactionId: undefined, observedBalance: bal, at: at(1) });
  return tx;
};
const rejected = () => {
  const tx = pending();
  tx.reject(FailureCode.InsufficientFunds, { observedBalance: bal, at: at(1) });
  return tx;
};
const failed = () => {
  const tx = pending();
  tx.fail(FailureCode.InternalPermanentError, { observedBalance: bal, at: at(1) });
  return tx;
};

describe('WagerTransaction.create', () => {
  test('nasce PENDING, sem failureCode, sem processedAt, attempts 0', () => {
    const tx = pending();
    expect(tx.status).toBe(S.Pending);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.attempts).toBe(0);
    expect(tx.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('OPENING não pode ser submetido via create', () => {
    expect(() => newTx(wallet, K.Opening, '10.00')).toThrow(InvariantViolationError);
  });

  test('REFUND e ROLLBACK exigem referência; WIN não exige', () => {
    expect(() => newTx(wallet, K.Refund, '10.00')).toThrow(InvariantViolationError);
    expect(() => newTx(wallet, K.Rollback, '10.00')).toThrow(InvariantViolationError);
    expect(() => newTx(wallet, K.Refund, '10.00', { referenceExternalTransactionId: '' })).toThrow(
      InvariantViolationError,
    );
    expect(newTx(wallet, K.Win, '10.00').status).toBe(S.Pending);
  });

  test('requiresReference por kind', () => {
    expect(pending(K.Bet).requiresReference()).toBe(false);
    expect(pending(K.Win).requiresReference()).toBe(false);
    expect(pending(K.Loss).requiresReference()).toBe(false);
    expect(pending(K.Refund).requiresReference()).toBe(true);
    expect(pending(K.Rollback).requiresReference()).toBe(true);
  });

  test('hasReference: WIN só quando informada; LOSS ignora referência', () => {
    expect(newTx(wallet, K.Win, '1.00').hasReference()).toBe(false);
    expect(
      newTx(wallet, K.Win, '1.00', { referenceExternalTransactionId: 'bet-1' }).hasReference(),
    ).toBe(true);
    expect(
      newTx(wallet, K.Loss, '0.00', { referenceExternalTransactionId: 'bet-1' }).hasReference(),
    ).toBe(false);
  });

  test('LOSS aceita 0; demais exigem > 0 (D4)', () => {
    expect(newTx(wallet, K.Loss, '0.00').money.isZero()).toBe(true);
    for (const kind of [K.Bet, K.Win]) {
      expect(() => newTx(wallet, kind, '0.00')).toThrow(InvariantViolationError);
    }
    expect(() => newTx(wallet, K.Loss, '-1.00')).toThrow(InvariantViolationError);
  });

  test('campos de identidade obrigatórios', () => {
    expect(() => newTx(wallet, K.Bet, '1.00', { roundId: ' ' })).toThrow(InvariantViolationError);
    expect(() => newTx(wallet, K.Bet, '1.00', { providerId: '' })).toThrow(InvariantViolationError);
  });

  test('affectsBalance: false só para LOSS', () => {
    expect(pending(K.Loss).affectsBalance()).toBe(false);
    for (const kind of [K.Bet, K.Win, K.Refund, K.Rollback]) {
      expect(pending(kind).affectsBalance()).toBe(true);
    }
  });

  test('matchesPayload compara o hash', () => {
    const tx = pending();
    expect(tx.matchesPayload(tx.payloadHash)).toBe(true);
    expect(tx.matchesPayload('outro')).toBe(false);
  });
});

describe('WagerTransaction.opening', () => {
  test('usa identidade interna determinística (E3) e kind OPENING', () => {
    const tx = WagerTransaction.opening({
      id: id(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: brl('100.00'),
      at: T0,
    });
    expect(tx.kind).toBe(K.Opening);
    expect(tx.providerId).toBe('internal');
    expect(tx.externalTransactionId).toBe(`opening:${wallet.id}`);
    expect(tx.idempotencyKey).toBe(`opening:${wallet.id}`);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe('Máquina de estados — transições válidas', () => {
  test('PENDING -> PROCESSED (com observedBalance e processedAt)', () => {
    const tx = processed();
    expect(tx.status).toBe(S.Processed);
    expect(tx.processedAt).toEqual(at(1));
    expect(tx.observedBalance?.toString()).toBe('100.00');
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING -> PROCESSED para LOSS', () => {
    const tx = newTx(wallet, K.Loss, '0.00');
    tx.markProcessed({ referenceTransactionId: undefined, observedBalance: bal, at: at(1) });
    expect(tx.status).toBe(S.Processed);
  });

  test('PENDING -> REJECTED com código de negócio', () => {
    const tx = rejected();
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.processedAt).toBeUndefined();
  });

  test('PENDING -> FAILED com código permanente', () => {
    const tx = failed();
    expect(tx.status).toBe(S.Failed);
    expect(tx.failureCode).toBe(FailureCode.InternalPermanentError);
  });

  test('PENDING -> PENDING_REFERENCE com agenda (nextAttemptAt e expiresAt)', () => {
    const tx = pendingRef();
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.nextAttemptAt).toEqual(at(2));
    expect(tx.expiresAt).toEqual(at(3600));
    expect(tx.isTerminal()).toBe(false);
  });

  test('PENDING_REFERENCE -> PENDING_REFERENCE (reagendamento incrementa attempts)', () => {
    const tx = pendingRef();
    tx.scheduleReferenceRetry(at(10), at(2));
    expect(tx.attempts).toBe(1);
    expect(tx.nextAttemptAt).toEqual(at(10));
  });

  test('PENDING_REFERENCE -> PROCESSED / REJECTED / FAILED', () => {
    const a = pendingRef();
    a.markProcessed({ referenceTransactionId: id(), observedBalance: bal, at: at(5) });
    expect(a.status).toBe(S.Processed);
    expect(a.nextAttemptAt).toBeUndefined();

    const b = pendingRef();
    b.reject(FailureCode.ReferenceNotFound, { observedBalance: bal, at: at(5) });
    expect(b.status).toBe(S.Rejected);

    const c = pendingRef();
    c.fail(FailureCode.RetryLimitExceeded, { observedBalance: undefined, at: at(5) });
    expect(c.status).toBe(S.Failed);
  });
});

describe('Máquina de estados — transições inválidas', () => {
  const terminals = { processed, rejected, failed };
  for (const [name, make] of Object.entries(terminals)) {
    test(`${name} é terminal: qualquer transição lança InvalidTransactionStateError`, () => {
      const tx = make();
      expect(() => {
        tx.markProcessed({ referenceTransactionId: undefined, observedBalance: bal, at: at(9) });
      }).toThrow(InvalidTransactionStateError);
      expect(() => {
        tx.reject(FailureCode.AmountMismatch, { observedBalance: bal, at: at(9) });
      }).toThrow(InvalidTransactionStateError);
      expect(() => {
        tx.fail(FailureCode.InternalPermanentError, { observedBalance: bal, at: at(9) });
      }).toThrow(InvalidTransactionStateError);
      expect(() => {
        tx.markPendingReference(policy.initial(T0), at(9));
      }).toThrow(InvalidTransactionStateError);
      expect(() => {
        tx.scheduleReferenceRetry(at(9), at(9));
      }).toThrow(InvalidTransactionStateError);
    });
  }

  test('PENDING_REFERENCE -> PENDING_REFERENCE via markPendingReference é inválido', () => {
    const tx = pendingRef();
    expect(() => {
      tx.markPendingReference(policy.initial(T0), at(1));
    }).toThrow(InvalidTransactionStateError);
  });

  test('scheduleReferenceRetry fora de PENDING_REFERENCE é inválido', () => {
    expect(() => {
      pending().scheduleReferenceRetry(at(1), at(1));
    }).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE sem referência a aguardar é inválido', () => {
    expect(() => {
      pending(K.Bet).markPendingReference(policy.initial(T0), T0);
    }).toThrow(InvariantViolationError);
  });

  test('REJECTED exige código de negócio; FAILED exige código permanente', () => {
    expect(() => {
      pending().reject(FailureCode.InternalPermanentError, { observedBalance: bal, at: at(1) });
    }).toThrow(InvariantViolationError);
    expect(() => {
      pending().fail(FailureCode.InsufficientFunds, { observedBalance: bal, at: at(1) });
    }).toThrow(InvariantViolationError);
  });

  test('REFUND/ROLLBACK não podem ser processados sem referência resolvida', () => {
    expect(() => {
      pending(K.Refund).markProcessed({
        referenceTransactionId: undefined,
        observedBalance: bal,
        at: at(1),
      });
    }).toThrow(InvariantViolationError);
  });
});

describe('ledgerDirectionFor', () => {
  test('BET debita; WIN e REFUND creditam', () => {
    expect(pending(K.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(pending(K.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(pending(K.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK inverte a direção da referência', () => {
    const rb = pending(K.Rollback);
    expect(rb.ledgerDirectionFor(pending(K.Bet))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(pending(K.Win))).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(pending(K.Refund))).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK sem referência, de LOSS ou de ROLLBACK é erro; LOSS não tem direção', () => {
    const rb = pending(K.Rollback);
    expect(() => rb.ledgerDirectionFor()).toThrow(InvariantViolationError);
    expect(() => rb.ledgerDirectionFor(pending(K.Loss))).toThrow(InvariantViolationError);
    expect(() => rb.ledgerDirectionFor(pending(K.Rollback))).toThrow(InvariantViolationError);
    expect(() => pending(K.Loss).ledgerDirectionFor()).toThrow(InvariantViolationError);
  });
});

describe('PendingReferencePolicy', () => {
  test('backoff 2s, fator 2, teto 5 min', () => {
    const delays = [0, 1, 2, 3, 7, 8, 19].map(
      (n) => (policy.nextAttemptAt(n, T0).getTime() - T0.getTime()) / 1000,
    );
    expect(delays).toEqual([2, 4, 8, 16, 256, 300, 300]);
  });

  test('esgota por tentativas OU por TTL, o que vier primeiro', () => {
    const expiresAt = at(3600);
    expect(policy.isExhausted(19, expiresAt, at(10))).toBe(false);
    expect(policy.isExhausted(20, expiresAt, at(10))).toBe(true);
    expect(policy.isExhausted(3, expiresAt, at(3600))).toBe(true);
  });
});
