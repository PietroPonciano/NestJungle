import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../src/domain/shared/domain-error';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction';
import {
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
} from '../../src/domain/wallet/wallet-ledger-entry';
import { T0, brl, id, usd } from '../support/factories';

const base = (over: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: id(),
  walletId: id(),
  transactionId: id(),
  direction: LedgerDirection.Debit,
  money: brl('80.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('20.00'),
  createdAt: T0,
  ...over,
});

describe('WalletLedgerEntry', () => {
  test('create valida aritmética de DEBIT e CREDIT', () => {
    expect(WalletLedgerEntry.create(base()).isBalanced()).toBe(true);
    const credit = WalletLedgerEntry.create(
      base({
        direction: LedgerDirection.Credit,
        balanceBefore: brl('20.00'),
        balanceAfter: brl('100.00'),
      }),
    );
    expect(credit.isBalanced()).toBe(true);
    expect(credit.signedAmount().toString()).toBe('80.00');
    expect(WalletLedgerEntry.create(base()).signedAmount().toString()).toBe('-80.00');
  });

  test('aritmética que não fecha é rejeitada', () => {
    expect(() => WalletLedgerEntry.create(base({ balanceAfter: brl('21.00') }))).toThrow(
      InvariantViolationError,
    );
    expect(() => WalletLedgerEntry.create(base({ direction: LedgerDirection.Credit }))).toThrow(
      InvariantViolationError,
    );
  });

  test('valor zero (LOSS) ou negativo não gera lançamento', () => {
    expect(() =>
      WalletLedgerEntry.create(
        base({ money: brl('0.00'), balanceBefore: brl('1.00'), balanceAfter: brl('1.00') }),
      ),
    ).toThrow(InvariantViolationError);
  });

  test('saldo negativo antes ou depois é rejeitado', () => {
    expect(() =>
      WalletLedgerEntry.create(base({ balanceBefore: brl('50.00'), balanceAfter: brl('-30.00') })),
    ).toThrow(InvariantViolationError);
  });

  test('moedas divergentes são rejeitadas', () => {
    expect(() => WalletLedgerEntry.create(base({ money: usd('80.00') }))).toThrow(
      InvariantViolationError,
    );
  });

  test('imutabilidade estrutural: sem setters nem métodos de transição', () => {
    const entry = WalletLedgerEntry.create(base());
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(entry));
    expect(proto.sort()).toEqual(['constructor', 'isBalanced', 'signedAmount']);
    for (const name of proto) {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(entry), name);
      // Só data descriptors (métodos); nenhum accessor com `set`.
      expect(Object.keys(desc ?? {})).not.toContain('set');
    }
  });
});
