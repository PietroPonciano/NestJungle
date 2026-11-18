/**
 * Classificação de erros do PostgreSQL (taxonomia §8.1).
 *
 * Transitório = repetir a mesma operação mais tarde pode dar certo, e nada foi
 * gravado (a transação inteira sofreu rollback). Nunca vira status persistido
 * (D7); no HTTP vira 503 + Retry-After e na fila, retry com backoff.
 */
const TRANSIENT_SQLSTATES = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
]);

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

interface ErrorLike {
  code?: unknown;
  sqlState?: unknown;
  constraint?: unknown;
  message?: unknown;
  name?: unknown;
  cause?: unknown;
}

function asErrorLike(error: unknown): ErrorLike | undefined {
  return typeof error === 'object' && error !== null ? error : undefined;
}

/** SQLSTATE do erro (MikroORM DriverException ou erro cru do `pg`). */
export function sqlStateOf(error: unknown): string | undefined {
  const e = asErrorLike(error);
  if (e === undefined) return undefined;
  for (const candidate of [e.sqlState, e.code]) {
    if (typeof candidate === 'string' && /^[0-9A-Z]{5}$/.test(candidate)) return candidate;
  }
  return e.cause !== undefined ? sqlStateOf(e.cause) : undefined;
}

export function constraintOf(error: unknown): string | undefined {
  const e = asErrorLike(error);
  if (e === undefined) return undefined;
  if (typeof e.constraint === 'string') return e.constraint;
  // MikroORM inclui a mensagem original do pg, que nomeia a constraint.
  if (typeof e.message === 'string') {
    const match = /constraint "([^"]+)"/.exec(e.message);
    if (match?.[1] !== undefined) return match[1];
  }
  return e.cause !== undefined ? constraintOf(e.cause) : undefined;
}

export function isTransientDbError(error: unknown): boolean {
  const state = sqlStateOf(error);
  if (state !== undefined) {
    // Classe 08 = connection_exception.
    return TRANSIENT_SQLSTATES.has(state) || state.startsWith('08');
  }
  const e = asErrorLike(error);
  if (e === undefined) return false;
  if (typeof e.code === 'string' && TRANSIENT_NODE_CODES.has(e.code)) return true;
  if (e.name === 'ConnectionException') return true;
  if (
    typeof e.message === 'string' &&
    /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect/i.test(
      e.message,
    )
  ) {
    return true;
  }
  return e.cause !== undefined ? isTransientDbError(e.cause) : false;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return (
    sqlStateOf(error) === '23505' &&
    (constraint === undefined || constraintOf(error) === constraint)
  );
}

/** Erros de lock (para a métrica de conflitos de lock). */
export function isLockConflict(error: unknown): boolean {
  const state = sqlStateOf(error);
  return state === '40P01' || state === '55P03';
}
