/**
 * Resultado de uma submissão (HTTP e SQS) e regras de replay.
 *
 * Regra 7 / guia §6.2: o replay devolve o RESULTADO ORIGINAL. O saldo é o
 * observed_balance gravado quando a transação ficou terminal; para
 * PENDING_REFERENCE, o saldo atual da wallet (D6).
 */
import type { MoneyProps } from '../../domain/money/money';
import type { Money } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wager-transaction/failure-code';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-kind';
import { IdempotencyConflictError } from '../errors';

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export function resultOf(
  tx: WagerTransaction,
  currentBalance: Money,
  replay: boolean,
): WagerResult {
  const balance =
    tx.isTerminal() && tx.observedBalance !== undefined ? tx.observedBalance : currentBalance;
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: balance.toJSON(),
    ...(tx.failureCode !== undefined ? { failureCode: tx.failureCode } : {}),
    idempotentReplay: replay,
  };
}

/**
 * Decide entre replay e conflito diante de transações já gravadas com a mesma
 * idempotency key e/ou o mesmo externalTransactionId (do mesmo provedor).
 *
 *  - mesma key + mesmo externalTransactionId + mesmo payloadHash -> replay
 *  - mesma key com payload diferente                              -> 409
 *  - mesmo externalTransactionId com key diferente (ou vice-versa) -> 409 (D5)
 */
export function replayOrConflict(
  existing: readonly WagerTransaction[],
  candidate: WagerTransaction,
  currentBalance: Money,
): WagerResult {
  const [found, other] = existing;
  if (found === undefined) throw new Error('replayOrConflict exige ao menos uma transação');
  if (other !== undefined) {
    throw new IdempotencyConflictError(
      'Idempotency-Key e externalTransactionId pertencem a transações diferentes',
    );
  }
  if (found.idempotencyKey !== candidate.idempotencyKey) {
    throw new IdempotencyConflictError(
      'externalTransactionId já registrado com outra Idempotency-Key',
    );
  }
  if (found.externalTransactionId !== candidate.externalTransactionId) {
    throw new IdempotencyConflictError('Idempotency-Key já usada para outro externalTransactionId');
  }
  if (!found.matchesPayload(candidate.payloadHash)) {
    throw new IdempotencyConflictError('Idempotency-Key já usada com payload diferente');
  }
  return resultOf(found, currentBalance, true);
}
