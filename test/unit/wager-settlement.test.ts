import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../src/domain/shared/domain-error';
import { FailureCode as F } from '../../src/domain/wager-transaction/failure-code';
import {
  DEFAULT_PENDING_REFERENCE_POLICY,
  PendingReferencePolicy,
} from '../../src/domain/wager-transaction/pending-reference-policy';
import type { WagerTransaction } from '../../src/domain/wager-transaction/wager-transaction';
import { WagerTransactionStatus as S } from '../../src/domain/wager-transaction/wager-transaction-kind';
import {
  decideSettlement,
  settle,
  type SettlementResult,
} from '../../src/domain/wager-transaction/wager-settlement';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction';
import type { Wallet } from '../../src/domain/wallet/wallet';
import {
  T0,
  WagerTransactionKind as K,
  at,
  id,
  newTx,
  openWallet,
  usd,
  type TxOverrides,
} from '../support/factories';

const policy = new PendingReferencePolicy(DEFAULT_PENDING_REFERENCE_POLICY);

function run(
  wallet: Wallet,
  tx: WagerTransaction,
  reference?: WagerTransaction,
  referenceAlreadyReversed = false,
  when: Date = at(1),
): SettlementResult {
  return settle({
    wallet,
    transaction: tx,
    reference,
    referenceAlreadyReversed,
    ledgerEntryId: id(),
    policy,
    at: when,
  });
}

/** Cria e liquida uma operação; devolve a transação já terminal. */
function processedTx(wallet: Wallet, kind: K, amount: string, reference?: WagerTransaction) {
  const tx = newTx(wallet, kind, amount, {
    referenceExternalTransactionId: reference?.externalTransactionId,
  });
  run(wallet, tx, reference);
  return tx;
}

const ref = (r: WagerTransaction, over: TxOverrides = {}) => ({
  referenceExternalTransactionId: r.externalTransactionId,
  ...over,
});

describe('BET', () => {
  test('debita e gera 1 lançamento DEBIT; observedBalance é o saldo após', () => {
    const w = openWallet('100.00');
    const tx = newTx(w, K.Bet, '25.00');
    const r = run(w, tx);
    expect(tx.status).toBe(S.Processed);
    expect(r.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toString()).toBe('75.00');
    expect(tx.observedBalance?.toString()).toBe('75.00');
  });

  test('cenário 100.00 + 2×80.00: 1 PROCESSED, 1 REJECTED INSUFFICIENT_FUNDS, saldo 20.00, 1 débito', () => {
    const w = openWallet('100.00');
    const a = newTx(w, K.Bet, '80.00');
    const b = newTx(w, K.Bet, '80.00');
    const results = [run(w, a), run(w, b)];
    expect(a.status).toBe(S.Processed);
    expect(b.status).toBe(S.Rejected);
    expect(b.failureCode).toBe(F.InsufficientFunds);
    expect(b.observedBalance?.toString()).toBe('20.00');
    expect(w.balance.toString()).toBe('20.00');
    expect(results.filter((r) => r.ledgerEntry !== undefined)).toHaveLength(1);
  });
});

describe('WIN', () => {
  test('sem referência: credita direto', () => {
    const w = openWallet('10.00');
    const tx = newTx(w, K.Win, '50.00');
    const r = run(w, tx);
    expect(tx.status).toBe(S.Processed);
    expect(r.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toString()).toBe('60.00');
  });

  test('com referência à BET da mesma rodada: credita e guarda referenceTransactionId', () => {
    const w = openWallet('100.00');
    const bet = processedTx(w, K.Bet, '10.00');
    const win = newTx(w, K.Win, '30.00', ref(bet)); // WIN pode ter valor diferente da BET
    run(w, win, bet);
    expect(win.status).toBe(S.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(w.balance.toString()).toBe('120.00');
  });

  test('com referência informada e ainda inexistente: PENDING_REFERENCE (E2)', () => {
    const w = openWallet('100.00');
    const win = newTx(w, K.Win, '30.00', { referenceExternalTransactionId: 'bet-futura' });
    run(w, win, undefined);
    expect(win.status).toBe(S.PendingReference);
  });

  test('referência que não é BET: REFERENCE_INVALID_KIND', () => {
    const w = openWallet('100.00');
    const loss = processedTx(w, K.Loss, '0.00');
    const win = newTx(w, K.Win, '30.00', ref(loss));
    run(w, win, loss);
    expect(win.failureCode).toBe(F.ReferenceInvalidKind);
  });
});

describe('LOSS', () => {
  test('PROCESSED sem mover saldo e sem lançamento', () => {
    const w = openWallet('100.00');
    const tx = newTx(w, K.Loss, '0.00');
    const r = run(w, tx);
    expect(tx.status).toBe(S.Processed);
    expect(r.ledgerEntry).toBeUndefined();
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(1);
    expect(tx.observedBalance?.toString()).toBe('100.00');
  });
});

describe('REFUND', () => {
  test('reverte BET PROCESSED: credita o valor', () => {
    const w = openWallet('100.00');
    const bet = processedTx(w, K.Bet, '40.00');
    const refund = newTx(w, K.Refund, '40.00', ref(bet));
    const r = run(w, refund, bet);
    expect(refund.status).toBe(S.Processed);
    expect(r.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('só referencia BET (regra 3)', () => {
    const w = openWallet('100.00');
    const win = processedTx(w, K.Win, '40.00');
    const refund = newTx(w, K.Refund, '40.00', ref(win));
    run(w, refund, win);
    expect(refund.failureCode).toBe(F.ReferenceInvalidKind);
  });

  test('valor diferente da referência: AMOUNT_MISMATCH (regra 5)', () => {
    const w = openWallet('100.00');
    const bet = processedTx(w, K.Bet, '40.00');
    const refund = newTx(w, K.Refund, '39.99', ref(bet));
    run(w, refund, bet);
    expect(refund.failureCode).toBe(F.AmountMismatch);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(w.balance.toString()).toBe('60.00');
  });

  test('referência já revertida: ALREADY_REVERSED (regra 4 / D1)', () => {
    const w = openWallet('100.00');
    const bet = processedTx(w, K.Bet, '40.00');
    const refund = newTx(w, K.Refund, '40.00', ref(bet));
    run(w, refund, bet, true);
    expect(refund.failureCode).toBe(F.AlreadyReversed);
  });
});

describe('ROLLBACK', () => {
  test('de BET: credita (inverso do débito)', () => {
    const w = openWallet('100.00');
    const bet = processedTx(w, K.Bet, '30.00');
    const rb = newTx(w, K.Rollback, '30.00', ref(bet));
    const r = run(w, rb, bet);
    expect(r.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('de WIN: debita (inverso do crédito)', () => {
    const w = openWallet('100.00');
    const win = processedTx(w, K.Win, '50.00');
    const rb = newTx(w, K.Rollback, '50.00', ref(win));
    const r = run(w, rb, win);
    expect(r.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('de REFUND: debita (inverso do crédito do REFUND)', () => {
    const w = openWallet('100.00');
    const bet = processedTx(w, K.Bet, '20.00');
    const refund = processedTx(w, K.Refund, '20.00', bet);
    const rb = newTx(w, K.Rollback, '20.00', ref(refund));
    const r = run(w, rb, refund);
    expect(r.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toString()).toBe('80.00');
  });

  test('de LOSS ou de outro ROLLBACK: REFERENCE_INVALID_KIND', () => {
    const w = openWallet('100.00');
    const loss = processedTx(w, K.Loss, '0.00');
    const rb1 = newTx(w, K.Rollback, '1.00', ref(loss));
    run(w, rb1, loss);
    expect(rb1.failureCode).toBe(F.ReferenceInvalidKind);

    const bet = processedTx(w, K.Bet, '5.00');
    const rb2 = processedTx(w, K.Rollback, '5.00', bet);
    const rb3 = newTx(w, K.Rollback, '5.00', ref(rb2));
    run(w, rb3, rb2);
    expect(rb3.failureCode).toBe(F.ReferenceInvalidKind);
  });

  test('reversão que deixaria saldo negativo: REVERSAL_WOULD_OVERDRAW (≠ INSUFFICIENT_FUNDS)', () => {
    const w = openWallet('0.00');
    const win = processedTx(w, K.Win, '50.00');
    processedTx(w, K.Bet, '45.00'); // jogador gastou o prêmio: saldo 5.00
    const rb = newTx(w, K.Rollback, '50.00', ref(win));
    const r = run(w, rb, win);
    expect(rb.status).toBe(S.Rejected);
    expect(rb.failureCode).toBe(F.ReversalWouldOverdraw);
    expect(rb.failureCode).not.toBe(F.InsufficientFunds);
    expect(r.ledgerEntry).toBeUndefined();
    expect(w.balance.toString()).toBe('5.00');
  });
});

describe('Validação da referência (regra 2) e D2', () => {
  const setup = () => {
    const w = openWallet('100.00');
    const bet = processedTx(w, K.Bet, '10.00');
    return { w, bet };
  };

  test('rodada diferente: REFERENCE_MISMATCH', () => {
    const { w, bet } = setup();
    const rf = newTx(w, K.Refund, '10.00', ref(bet, { roundId: 'outra-rodada' }));
    run(w, rf, bet);
    expect(rf.failureCode).toBe(F.ReferenceMismatch);
  });

  test('wallet/player da referência diferentes: REFERENCE_MISMATCH', () => {
    const { w } = setup();
    const other = openWallet('100.00');
    const otherBet = processedTx(other, K.Bet, '10.00');
    const rf = newTx(w, K.Refund, '10.00', ref(otherBet));
    run(w, rf, otherBet);
    expect(rf.failureCode).toBe(F.ReferenceMismatch);
  });

  test('provider diferente: REFERENCE_MISMATCH (defensivo; a busca já filtra por provider)', () => {
    const { w, bet } = setup();
    const rf = newTx(w, K.Refund, '10.00', ref(bet, { providerId: 'provider-b' }));
    run(w, rf, bet);
    expect(rf.failureCode).toBe(F.ReferenceMismatch);
  });

  test('referência PENDING / PENDING_REFERENCE: aguarda', () => {
    const { w } = setup();
    const pendingBet = newTx(w, K.Bet, '10.00');
    const rf = newTx(w, K.Refund, '10.00', ref(pendingBet));
    run(w, rf, pendingBet);
    expect(rf.status).toBe(S.PendingReference);
  });

  test('referência REJECTED: REFERENCE_NOT_PROCESSED na hora (D2)', () => {
    const w = openWallet('5.00');
    const bet = processedTx(w, K.Bet, '10.00'); // REJECTED por saldo
    expect(bet.status).toBe(S.Rejected);
    const rf = newTx(w, K.Refund, '10.00', ref(bet));
    run(w, rf, bet);
    expect(rf.failureCode).toBe(F.ReferenceNotProcessed);
    expect(w.balance.toString()).toBe('5.00');
  });
});

describe('Conflitos de moeda e player', () => {
  test('moeda da operação ≠ moeda da wallet: CURRENCY_MISMATCH', () => {
    const w = openWallet('100.00');
    const tx = newTx(w, K.Bet, '1.00', { money: usd('1.00') });
    run(w, tx);
    expect(tx.failureCode).toBe(F.CurrencyMismatch);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('playerId ≠ player da wallet: PLAYER_MISMATCH', () => {
    const w = openWallet('100.00');
    const tx = newTx(w, K.Bet, '1.00', { playerId: id() });
    run(w, tx);
    expect(tx.failureCode).toBe(F.PlayerMismatch);
  });
});

describe('PENDING_REFERENCE → resolução e expiração', () => {
  test('referência chega depois: PENDING_REFERENCE → PROCESSED', () => {
    const w = openWallet('100.00');
    const rb = newTx(w, K.Rollback, '30.00', { referenceExternalTransactionId: 'bet-x' });
    run(w, rb, undefined);
    expect(rb.status).toBe(S.PendingReference);
    // A BET referenciada ('bet-x') chega e é processada depois do ROLLBACK.
    const bet = newTx(w, K.Bet, '30.00', { externalTransactionId: 'bet-x' });
    run(w, bet);
    expect(w.balance.toString()).toBe('70.00');
    run(w, rb, bet, false, at(5));
    expect(rb.referenceTransactionId).toBe(bet.id);
    expect(rb.status).toBe(S.Processed);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('referência ausente em nova tentativa: reagenda com backoff', () => {
    const w = openWallet('100.00');
    const rf = newTx(w, K.Refund, '1.00', { referenceExternalTransactionId: 'nunca' });
    run(w, rf, undefined, false, T0);
    run(w, rf, undefined, false, at(2));
    expect(rf.status).toBe(S.PendingReference);
    expect(rf.attempts).toBe(1);
    expect(rf.nextAttemptAt).toEqual(at(2 + 4));
  });

  test('esgotado o TTL: REJECTED REFERENCE_NOT_FOUND sem mover saldo', () => {
    const w = openWallet('100.00');
    const rf = newTx(w, K.Refund, '1.00', { referenceExternalTransactionId: 'nunca' });
    run(w, rf, undefined, false, T0);
    run(w, rf, undefined, false, at(3600));
    expect(rf.status).toBe(S.Rejected);
    expect(rf.failureCode).toBe(F.ReferenceNotFound);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('esgotado o limite de tentativas: REJECTED REFERENCE_NOT_FOUND', () => {
    const w = openWallet('100.00');
    const rf = newTx(w, K.Refund, '1.00', { referenceExternalTransactionId: 'nunca' });
    run(w, rf, undefined, false, T0);
    for (let i = 1; i <= 20; i++) run(w, rf, undefined, false, at(i));
    expect(rf.status).toBe(S.Rejected);
    expect(rf.failureCode).toBe(F.ReferenceNotFound);
    expect(rf.attempts).toBe(19);
  });
});

describe('Pré-condições', () => {
  test('transação terminal, wallet errada: erro de programação', () => {
    const w = openWallet('100.00');
    const tx = processedTx(w, K.Bet, '1.00');
    expect(() =>
      decideSettlement({
        wallet: w,
        transaction: tx,
        reference: undefined,
        referenceAlreadyReversed: false,
      }),
    ).toThrow(InvariantViolationError);
    const other = openWallet('100.00');
    expect(() =>
      decideSettlement({
        wallet: other,
        transaction: newTx(w, K.Bet, '1.00'),
        reference: undefined,
        referenceAlreadyReversed: false,
      }),
    ).toThrow(InvariantViolationError);
  });
});

describe('BALANCE_LIMIT_EXCEEDED', () => {
  test('WIN que estouraria o limite do saldo: REJECTED (422), sem lançamento', () => {
    const w = openWallet('9999999999999999.99');
    const tx = newTx(w, K.Win, '1.00');
    const r = run(w, tx);
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(F.BalanceLimitExceeded);
    expect(r.ledgerEntry).toBeUndefined();
    expect(w.balance.toString()).toBe('9999999999999999.99');
  });

  test('REFUND que estouraria o limite: REJECTED com a referência registrada', () => {
    const w = openWallet('9999999999999999.99');
    const bet = processedTx(w, K.Bet, '0.01'); // saldo 9999999999999999.98
    processedTx(w, K.Win, '0.01'); // volta ao máximo
    const refund = newTx(w, K.Refund, '0.01', ref(bet));
    run(w, refund, bet);
    expect(refund.failureCode).toBe(F.BalanceLimitExceeded);
    expect(refund.referenceTransactionId).toBe(bet.id);
  });
});
