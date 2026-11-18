/**
 * Contrato da mensagem de entrada (enunciado §10):
 * { messageId, type: "WagerTransactionRequested", occurredAt, data: {...} }
 *
 * O hash da inbox é o SHA-256 do JSON canônico de { type, data } JÁ
 * normalizado (amount com 2 casas). O mesmo messageId com conteúdo diferente
 * é conflito, não redelivery.
 */
import { createHash } from 'node:crypto';
import { InvalidPayloadError } from '../../application/errors';
import type { SubmitWagerCommand } from '../../application/use-cases/submit-wager-transaction';
import { canonicalJson } from '../../domain/shared/canonical-json';
import { isObject, parseIdempotencyKey, parseWagerFields } from '../shared/payload-parsers';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

export interface ParsedWagerMessage {
  messageId: string;
  command: SubmitWagerCommand;
  payloadHash: string;
}

/** Extrai o messageId mesmo de mensagem inválida (para log/DLQ). */
export function peekMessageId(body: string | undefined): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body ?? '');
    return isObject(parsed) && typeof parsed.messageId === 'string' ? parsed.messageId : undefined;
  } catch {
    return undefined;
  }
}

export function parseWagerMessage(body: string | undefined): ParsedWagerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body ?? '');
  } catch {
    throw new InvalidPayloadError('Mensagem não é JSON válido');
  }
  if (!isObject(parsed)) throw new InvalidPayloadError('Mensagem deve ser objeto JSON');
  const { messageId, type, data } = parsed;
  if (typeof messageId !== 'string' || messageId.trim() === '' || messageId.length > 255) {
    throw new InvalidPayloadError('messageId obrigatório');
  }
  if (type !== WAGER_MESSAGE_TYPE) {
    throw new InvalidPayloadError(`type deve ser ${WAGER_MESSAGE_TYPE}`);
  }
  if (!isObject(data)) throw new InvalidPayloadError('data obrigatório');

  const command = parseWagerFields(
    data,
    parseIdempotencyKey(data.idempotencyKey, 'data.idempotencyKey'),
    'data',
  );
  const payloadHash = createHash('sha256')
    .update(
      canonicalJson({
        type,
        data: {
          ...command,
          money: { amount: command.money.toString(), currency: command.money.currency },
          referenceExternalTransactionId: command.referenceExternalTransactionId,
        },
      }),
      'utf8',
    )
    .digest('hex');
  return { messageId, command, payloadHash };
}
