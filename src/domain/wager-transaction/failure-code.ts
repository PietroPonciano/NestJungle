/**
 * Taxonomia de failureCode (enunciado §7.2; guia §8.1).
 *
 * Invariantes:
 *  - Todo REJECTED carrega um código de categoria BUSINESS; todo FAILED, um de
 *    categoria PERMANENT. A máquina de estados da WagerTransaction impõe isso,
 *    e o CHECK ck_tx_failure_code garante no banco que REJECTED/FAILED <=>
 *    failure_code não nulo.
 *  - Não existem códigos de duplicata (duplicata é replay, não falha) nem de
 *    erro transitório (D7: transitório nunca é persistido).
 *  - WALLET_NOT_FOUND e INVALID_PAYLOAD NÃO estão aqui: não há linha de
 *    transação possível para eles (FK/NOT NULL). Viram 404/400 no HTTP e DLQ
 *    sem linha na fila.
 *  - Os valores são estáveis: provedores tomam decisão a partir deles.
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  AlreadyReversed = 'ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerMismatch = 'PLAYER_MISMATCH',
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  InternalPermanentError = 'INTERNAL_PERMANENT_ERROR',
  RetryLimitExceeded = 'RETRY_LIMIT_EXCEEDED',
}

export enum FailureCategory {
  /** REJECTED: resultado legítimo; commit + ack; nunca vai à DLQ. HTTP 422. */
  Business = 'BUSINESS',
  /** FAILED: erro permanente com linha gravável; auditável + DLQ. HTTP 500. */
  Permanent = 'PERMANENT',
}

/** O que o provedor deve fazer ao receber o código. */
export enum ProviderAction {
  RetryLater = 'RETRY_LATER',
  FixPayload = 'FIX_PAYLOAD',
  GiveUp = 'GIVE_UP',
  Investigate = 'INVESTIGATE',
}

interface FailureCodeSpec {
  category: FailureCategory;
  providerAction: ProviderAction;
  description: string;
}

export const FAILURE_CODES: Readonly<Record<FailureCode, FailureCodeSpec>> = {
  [FailureCode.InsufficientFunds]: {
    category: FailureCategory.Business,
    providerAction: ProviderAction.GiveUp,
    description: 'BET sem saldo suficiente (reenviar só com saldo)',
  },
  [FailureCode.ReversalWouldOverdraw]: {
    category: FailureCategory.Business,
    providerAction: ProviderAction.Investigate,
    description: 'Reversão debitaria além do saldo (regra 9); incidente operacional',
  },
  [FailureCode.ReferenceNotFound]: {
    category: FailureCategory.Business,
    providerAction: ProviderAction.FixPayload,
    description: 'Referência inexistente após TTL/limite de tentativas',
  },
  [FailureCode.ReferenceNotProcessed]: {
    category: FailureCategory.Business,
    providerAction: ProviderAction.GiveUp,
    description: 'Referência existe, mas terminou REJECTED/FAILED (D2)',
  },
  [FailureCode.ReferenceMismatch]: {
    category: FailureCategory.Business,
    providerAction: ProviderAction.FixPayload,
    description: 'Player, wallet ou rodada diferentes dos da referência',
  },
  [FailureCode.ReferenceInvalidKind]: {
    category: FailureCategory.Business,
    providerAction: ProviderAction.FixPayload,
    description: 'Kind da referência não é revertível/referenciável por esta operação',
  },
  [FailureCode.AlreadyReversed]: {
    category: FailureCategory.Business,
    providerAction: ProviderAction.GiveUp,
    description: 'Referência já revertida (D1)',
  },
  [FailureCode.AmountMismatch]: {
    category: FailureCategory.Business,
    providerAction: ProviderAction.FixPayload,
    description: 'Valor da reversão diferente do valor da referência',
  },
  [FailureCode.CurrencyMismatch]: {
    category: FailureCategory.Business,
    providerAction: ProviderAction.FixPayload,
    description: 'Moeda diferente da moeda da wallet ou da referência',
  },
  [FailureCode.PlayerMismatch]: {
    category: FailureCategory.Business,
    providerAction: ProviderAction.FixPayload,
    description: 'playerId do payload diferente do player da wallet',
  },
  [FailureCode.BalanceLimitExceeded]: {
    category: FailureCategory.Business,
    providerAction: ProviderAction.Investigate,
    description: 'Crédito levaria o saldo além do limite representável (NUMERIC(18,2))',
  },
  [FailureCode.InternalPermanentError]: {
    category: FailureCategory.Permanent,
    providerAction: ProviderAction.Investigate,
    description: 'Erro permanente inesperado; não reenviar sem investigação',
  },
  [FailureCode.RetryLimitExceeded]: {
    category: FailureCategory.Permanent,
    providerAction: ProviderAction.RetryLater,
    description: 'Tentativas da fila esgotadas por erro transitório persistente',
  },
};

export function categoryOf(code: FailureCode): FailureCategory {
  return FAILURE_CODES[code].category;
}
