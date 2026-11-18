/**
 * Erros de domínio.
 *
 * Invariante: erros de domínio representam violação de uma regra do modelo,
 * nunca falha de infraestrutura. Eles NÃO são o caminho normal de rejeição de
 * negócio (esse caminho é a transição REJECTED + FailureCode); aqui ficam as
 * guardas defensivas: entrada inválida, operação entre moedas diferentes,
 * transição a partir de estado terminal etc.
 *
 * `code` é estável e legível por máquina. A camada HTTP mapeia esses erros
 * para 400/500 num filtro único.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  // Público porque a classe é abstrata (não instanciável diretamente) e as
  // subclasses que só repassam a mensagem herdam este construtor.
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Valor monetário ou moeda em formato inválido (contrato de entrada). */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

/** Operação entre moedas diferentes (Money.assertSameCurrency, Wallet). */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(expected: string, received: string) {
    super(`Moeda divergente: esperado ${expected}, recebido ${received}`);
  }
}

/** Débito que deixaria o saldo negativo (guarda defensiva da Wallet). */
export class InsufficientBalanceError extends DomainError {
  readonly code = 'INSUFFICIENT_BALANCE';
  constructor(walletId: string) {
    super(`Débito deixaria a wallet ${walletId} com saldo negativo`);
  }
}

/** Dados que violam uma invariante de construção de um objeto de domínio. */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';
}

/**
 * Transição a partir de estado terminal (ou não permitida pela máquina de
 * estados). É erro de programação, não caminho de negócio (enunciado §6.3).
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  constructor(transactionId: string, from: string, to: string) {
    super(`Transição inválida da transação ${transactionId}: ${from} -> ${to}`);
  }
}
