/**
 * Tipos de operação e status de uma WagerTransaction.
 *
 * Invariantes:
 *  - Os valores espelham exatamente os CHECKs `kind IN (...)` e
 *    `status IN (...)` de wager_transactions: o banco recusa qualquer outro.
 *  - OPENING é interno (crédito de abertura da wallet): nunca é aceito em
 *    contratos externos. SUBMITTABLE_KINDS é a lista aceita por HTTP e SQS.
 *  - PROCESSED, REJECTED e FAILED são terminais (TERMINAL_STATUSES): uma
 *    transação nesses estados não muda mais. É a única definição dessa regra
 *    no código.
 */
export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca submetível por API ou fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

/** Kinds aceitos em contratos externos (HTTP e SQS): todos menos OPENING. */
export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/** Status. Espelha o CHECK status IN (...) de wager_transactions. */
export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];
