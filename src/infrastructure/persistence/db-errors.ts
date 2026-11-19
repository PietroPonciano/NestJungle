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
  '25006', // read_only_sql_transaction (failover: conectado a uma réplica)
  '58030', // io_error
]);

/**
 * Classes inteiras transitórias:
 *  08 = connection_exception;
 *  53 = insufficient_resources (disk_full, out_of_memory, too_many_connections...).
 * Recursos esgotados se resolvem sem mudar a requisição; persistir FAILED aqui
 * queimaria a idempotency key por um problema de infraestrutura.
 */
const TRANSIENT_SQLSTATE_CLASSES = ['08', '53'];

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

// Mensagens do `pg`/pool sem SQLSTATE nem código de rede.
const TRANSIENT_MESSAGE =
  /Connection terminated|connect ECONNREFUSED|timeout exceeded when trying to connect|Client has encountered a connection error|Connection ended unexpectedly|Client was closed and is not queryable/i;

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
    return (
      TRANSIENT_SQLSTATES.has(state) ||
      TRANSIENT_SQLSTATE_CLASSES.some((cls) => state.startsWith(cls))
    );
  }
  const e = asErrorLike(error);
  if (e === undefined) return false;
  if (typeof e.code === 'string' && TRANSIENT_NODE_CODES.has(e.code)) return true;
  if (e.name === 'ConnectionException') return true;
  if (typeof e.message === 'string' && TRANSIENT_MESSAGE.test(e.message)) return true;
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
