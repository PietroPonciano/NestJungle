/**
 * Erros da camada de aplicação. Cada um corresponde a uma linha da tabela de
 * status HTTP (guia §7.3) e a um tratamento no consumidor SQS (§8.1):
 *
 *   InvalidPayloadError           400 | DLQ, sem linha (não persistido — D7)
 *   WalletNotFoundError           404 | DLQ, sem linha (não persistido — D7)
 *   WalletAlreadyExistsError      409 | —
 *   IdempotencyConflictError      409 | DLQ (erro do provedor, não replay)
 *   InboxConflictError            —   | DLQ (mesmo messageId, payload diferente)
 *   TransientInfrastructureError  503 + Retry-After | retry com backoff (nunca persistido)
 *   ConcurrentInsertConflictError 503 | retry (ver uso em submit-wager-transaction)
 *
 * Rejeição de negócio NÃO é exceção: é um resultado (REJECTED + failureCode, 422).
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidPayloadError extends ApplicationError {
  readonly code = 'INVALID_PAYLOAD';
  constructor(
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
  constructor(walletId: string) {
    super(`Wallet ${walletId} não encontrada`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor(playerId: string, currency: string) {
    super(`Já existe wallet para o player ${playerId} na moeda ${currency}`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
  constructor(reference: string) {
    super(`Transação ${reference} não encontrada`);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

export class InboxConflictError extends ApplicationError {
  readonly code = 'INBOX_CONFLICT';
  constructor(messageId: string) {
    super(`messageId ${messageId} já recebido com payload diferente`);
  }
}

/** Principal autenticado não pode agir como o providerId do payload (ProviderIdentityPort). */
export class ProviderNotAuthorizedError extends ApplicationError {
  readonly code = 'PROVIDER_NOT_AUTHORIZED';
  constructor(providerId: string) {
    super(`Não autorizado a submeter operações do provedor ${providerId}`);
  }
}

export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_INFRASTRUCTURE_ERROR';
  constructor(
    message: string,
    override readonly cause?: unknown,
    /** Sugestão de espera para o cliente (header Retry-After). */
    readonly retryAfterSeconds: number = 1,
  ) {
    super(message);
  }
}

/** Conflito de unicidade inesperado sob corrida; repetir resolve (vira replay ou ALREADY_REVERSED). */
export class ConcurrentInsertConflictError extends TransientInfrastructureError {}
