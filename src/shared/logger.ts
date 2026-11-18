/**
 * Logger estruturado (JSON, uma linha por evento), com campos de correlação
 * (correlationId, messageId, transactionId, walletId, providerId).
 *
 * Regra (enunciado §12): sem dados sensíveis nem payload financeiro completo.
 * Quem chama passa só identificadores e status, nunca o corpo da requisição
 * ou da mensagem.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface AppLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): AppLogger;
}

export class JsonLogger implements AppLogger {
  constructor(
    private readonly minLevel: LogLevel = 'info',
    private readonly base: LogFields = {},
    private readonly sink: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
  ) {}

  debug(msg: string, fields?: LogFields): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.write('error', msg, fields);
  }

  child(fields: LogFields): AppLogger {
    return new JsonLogger(this.minLevel, { ...this.base, ...fields }, this.sink);
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, msg };
    for (const [k, v] of Object.entries({ ...this.base, ...fields })) {
      if (v !== undefined) entry[k] = v;
    }
    this.sink(JSON.stringify(entry));
  }
}

export function parseLogLevel(value: string | undefined): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}
