/**
 * Leitura do `maxReceiveCount` da RedrivePolicy de uma fila SQS.
 *
 * A redrive da fila é a fonte da verdade do limite de tentativas antes da DLQ
 * (enunciado §10). O consumidor usa este valor para decidir quando gravar
 * FAILED RETRY_LIMIT_EXCEEDED (decisão E4), em vez de confiar só em
 * SQS_MAX_RECEIVE_COUNT, que pode divergir da fila.
 */

/** Devolve o maxReceiveCount (inteiro >= 1) ou undefined se ausente/inválido. */
export function parseRedriveMaxReceiveCount(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('maxReceiveCount' in parsed)) {
    return undefined;
  }
  // A AWS devolve o valor como string ("5"); aceitamos também número.
  const value = parsed.maxReceiveCount;
  const count =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isSafeInteger(count) && count >= 1 ? count : undefined;
}
