/**
 * payloadHash = SHA-256 (hex) do JSON canônico dos campos de negócio.
 *
 * Invariantes:
 *  - Campos incluídos (guia §6.3): providerId, externalTransactionId, playerId,
 *    walletId, roundId, gameId, kind, money { amount, currency } e
 *    referenceExternalTransactionId (só quando presente).
 *  - Excluídos: header Idempotency-Key, messageId, occurredAt, correlationId e
 *    qualquer outro metadado de transporte. Assim, a mesma operação chegando
 *    por HTTP ou por SQS produz o mesmo hash.
 *  - `amount` sempre normalizado com 2 casas via Money ("25" e "25.00"
 *    representam o mesmo valor e o mesmo hash).
 *  - Mesma idempotency key com hash diferente = conflito, não replay.
 */
import { createHash } from 'node:crypto';
import type { Money } from '../money/money';
import { canonicalJson } from '../shared/canonical-json';
import type { WagerTransactionKind } from './wager-transaction-kind';

export interface PayloadHashFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

export function computePayloadHash(fields: PayloadHashFields): string {
  const canonical = canonicalJson({
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.toString(), currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
