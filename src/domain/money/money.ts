/**
 * Money — value object monetário.
 *
 * Invariantes encapsuladas:
 *  - Restrição #1: o valor NUNCA passa por `number`. Entra e sai como string
 *    decimal e é mantido em `Decimal` (decimal.js), aritmética exata.
 *  - Escala fixa de 2 casas: toJSON/toString sempre produzem "x.yy".
 *  - Imutável: toda operação devolve uma nova instância.
 *  - Operações entre moedas diferentes lançam CurrencyMismatchError.
 *  - Magnitude cabe em NUMERIC(18,2) (até 16 dígitos inteiros), para que nada
 *    aceito no domínio estoure a coluna no banco.
 *  - Formatos rejeitados: NaN, Infinity, notação científica, string vazia,
 *    mais de 2 casas decimais, zeros à esquerda, espaços.
 *  - Valores negativos: `from` aceita o sinal (para resultados internos como
 *    `negate` e diferenças de reconciliação), mas `fromInput` — usado nos
 *    contratos HTTP/SQS — rejeita negativos.
 */
import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../shared/domain-error';

/** DTO de contrato: { "amount": "25.00", "currency": "BRL" }. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

// Construtor isolado de decimal.js: não depende nem altera a config global.
// Soma/subtração em escala 2 são exatas; a precisão alta só evita surpresas.
const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

// Sem expoente, sem "+", sem zeros à esquerda, 0 a 2 casas decimais.
// Ex.: "25", "25.5" e "25.00" são aceitos e normalizados para 2 casas.
const AMOUNT_PATTERN = /^-?(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 2;
// NUMERIC(18,2): |valor| < 10^16. Vale também para resultados de add/subtract.
const MAX_EXCLUSIVE = new Dec('1e16');

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Constrói a partir de MoneyProps (aceita sinal). Usado também na reidratação. */
  static from(props: MoneyProps): Money {
    // Checagem de tipo em runtime: o contrato chega de JSON não confiável.
    if (typeof props.amount !== 'string' || typeof props.currency !== 'string') {
      throw new InvalidMoneyError('amount e currency devem ser strings');
    }
    if (!CURRENCY_PATTERN.test(props.currency)) {
      throw new InvalidMoneyError(`Moeda inválida (ISO-4217 esperado): "${props.currency}"`);
    }
    if (!AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`Valor monetário inválido: "${props.amount}"`);
    }
    return Money.of(new Dec(props.amount), props.currency);
  }

  /** Contrato de entrada (HTTP/SQS): mesmo formato de `from`, mas sem negativos. */
  static fromInput(props: MoneyProps): Money {
    const money = Money.from(props);
    if (money.isNegative()) {
      throw new InvalidMoneyError('Valor monetário negativo não é aceito na entrada');
    }
    return money;
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  /** true se `this + other` ainda cabe em NUMERIC(18,2) (sem lançar). */
  canAdd(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.plus(other.value).abs().lessThan(MAX_EXCLUSIVE);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Apenas o valor decimal com escala 2 (ex.: "25.00"), sem moeda. */
  toString(): string {
    return this.value.toFixed(SCALE);
  }

  // Único ponto de criação: normaliza -0 e garante que o valor cabe na coluna.
  private static of(value: Decimal, currency: string): Money {
    if (value.abs().greaterThanOrEqualTo(MAX_EXCLUSIVE)) {
      throw new InvalidMoneyError('Valor monetário excede NUMERIC(18,2)');
    }
    return new Money(value.isZero() ? new Dec(0) : value, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
