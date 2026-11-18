import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvariantViolationError,
} from '../../src/domain/shared/domain-error';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { T0, brl, id, openWallet, usd } from '../support/factories';

const later = new Date(T0.getTime() + 1000);
const move = (amount: string) => ({
  entryId: id(),
  transactionId: id(),
  money: brl(amount),
  at: later,
});

describe('Wallet.open', () => {
  test('com saldo inicial: version 1 e lançamento CREDIT de OPENING', () => {
    const txId = id();
    const { wallet, openingEntry } = Wallet.open({
      id: id(),
      playerId: id(),
      initialBalance: brl('1000.00'),
      openingTransactionId: txId,
      openingEntryId: id(),
      at: T0,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.transactionId).toBe(txId);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
  });

  test('saldo inicial zero: sem lançamento (D3)', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: id(),
      playerId: id(),
      initialBalance: brl('0.00'),
      openingTransactionId: id(),
      openingEntryId: id(),
      at: T0,
    });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('saldo inicial negativo é rejeitado', () => {
    expect(() =>
      Wallet.open({
        id: id(),
        playerId: id(),
        initialBalance: brl('-1.00'),
        openingTransactionId: id(),
        openingEntryId: id(),
        at: T0,
      }),
    ).toThrow(InvariantViolationError);
  });
});

describe('Wallet.debit / credit', () => {
  test('debit reduz saldo, incrementa version e devolve lançamento balanceado', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(move('80.00'));
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('credit aumenta saldo e incrementa version', () => {
    const wallet = openWallet('10.00');
    const entry = wallet.credit(move('5.50'));
    expect(wallet.balance.toString()).toBe('15.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('debit que deixaria saldo negativo é rejeitado sem mudar estado', () => {
    const wallet = openWallet('100.00');
    wallet.debit(move('80.00'));
    expect(wallet.canDebit(brl('80.00'))).toBe(false);
    expect(() => wallet.debit(move('80.00'))).toThrow(InsufficientBalanceError);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  test('debit do saldo exato zera a wallet (permitido)', () => {
    const wallet = openWallet('20.00');
    wallet.debit(move('20.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('conflito de moeda em debit, credit e canDebit', () => {
    const wallet = openWallet('100.00');
    const usdMove = { ...move('1.00'), money: usd('1.00') };
    expect(() => wallet.debit(usdMove)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usdMove)).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('valor zero não gera lançamento nem muda version', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit(move('0.00'))).toThrow(InvariantViolationError);
    expect(wallet.version).toBe(1);
  });

  test('version só incrementa quando o saldo muda (consultas não incrementam)', () => {
    const wallet = openWallet('100.00');
    wallet.canDebit(brl('1.00'));
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('rehydrate reconstrói estado sem revalidar', () => {
    const w = Wallet.rehydrate({
      id: id(),
      playerId: id(),
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: T0,
      updatedAt: later,
    });
    expect(w.version).toBe(7);
    expect(w.balance.toString()).toBe('42.00');
  });
});
