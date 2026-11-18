import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/shared/domain-error';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('Money — escala e serialização', () => {
  test('serializa sempre com 2 casas', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test('aritmética decimal exata (sem erro de ponto flutuante)', () => {
    // 0.1 + 0.2 em float = 0.30000000000000004
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
    expect(brl('9999999999999999.99').subtract(brl('0.01')).toString()).toBe('9999999999999999.98');
  });

  test('não arredonda: mais de 2 casas é rejeitado, nunca truncado', () => {
    expect(() => brl('0.005')).toThrow(InvalidMoneyError);
    expect(() => brl('10.999')).toThrow(InvalidMoneyError);
  });

  test('imutável: operações devolvem novas instâncias', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('15.00');
    expect(b).not.toBe(a);
  });

  test('negate, isZero, isPositive, isNegative, isLessThan, equals', () => {
    expect(brl('5.00').negate().toString()).toBe('-5.00');
    expect(brl('0.00').negate().toString()).toBe('0.00');
    expect(brl('-0.00').toString()).toBe('0.00');
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('-0.01').isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });
});

describe('Money — entradas inválidas', () => {
  const invalid = [
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E-2',
    '',
    ' ',
    ' 1.00',
    '1.00 ',
    '+1.00',
    '01.00',
    '1.',
    '.5',
    '1,00',
    '0x10',
    '1.234',
    '10000000000000000.00', // 17 dígitos inteiros: não cabe em NUMERIC(18,2)
  ];
  for (const amount of invalid) {
    test(`rejeita amount ${JSON.stringify(amount)}`, () => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });
  }

  test('rejeita tipos que não são string (JSON não confiável)', () => {
    const fromUnknown = (props: unknown) =>
      Money.from(props as { amount: string; currency: string });
    expect(() => fromUnknown({ amount: 25, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => fromUnknown({ amount: '25.00', currency: null })).toThrow(InvalidMoneyError);
  });

  test('rejeita moeda fora do ISO-4217', () => {
    for (const currency of ['brl', 'BR', 'BRLL', '', '123']) {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    }
  });

  test('fromInput rejeita negativos; from aceita (uso interno)', () => {
    expect(() => Money.fromInput({ amount: '-1.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(Money.fromInput({ amount: '0.00', currency: 'BRL' }).isZero()).toBe(true);
    expect(brl('-1.00').isNegative()).toBe(true);
  });

  test('resultado de operação que estoura NUMERIC(18,2) é rejeitado', () => {
    expect(() => brl('9999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyError);
  });
});

describe('Money — conflito de moeda', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });
  test('add/subtract/isLessThan entre moedas diferentes lançam erro de domínio', () => {
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Money — canAdd (limite de NUMERIC(18,2))', () => {
  test('true dentro do limite; false quando a soma estouraria, sem lançar', () => {
    const max = Money.from({ amount: '9999999999999999.98', currency: 'BRL' });
    expect(max.canAdd(Money.from({ amount: '0.01', currency: 'BRL' }))).toBe(true);
    expect(max.canAdd(Money.from({ amount: '0.02', currency: 'BRL' }))).toBe(false);
  });

  test('moedas diferentes continuam sendo erro de domínio', () => {
    expect(() =>
      Money.from({ amount: '1.00', currency: 'BRL' }).canAdd(
        Money.from({ amount: '1.00', currency: 'USD' }),
      ),
    ).toThrow(CurrencyMismatchError);
  });
});
