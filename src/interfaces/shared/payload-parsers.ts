/**
 * Validação dos contratos de entrada (HTTP e SQS), sem depender de metadata
 * de decorators (o Bun não emite design:paramtypes — decisão E7).
 *
 * Tudo que chega é `unknown` (JSON não confiável). Qualquer violação vira
 * InvalidPayloadError (400 no HTTP; DLQ sem linha na fila — D7), com a lista
 * de campos problemáticos em `details`.
 */
import { InvalidPayloadError } from '../../application/errors';
import type { SubmitWagerCommand } from '../../application/use-cases/submit-wager-transaction';
import { Money } from '../../domain/money/money';
import { DomainError } from '../../domain/shared/domain-error';
import {
  SUBMITTABLE_KINDS,
  type WagerTransactionKind,
} from '../../domain/wager-transaction/wager-transaction-kind';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 255;

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Acumula erros de validação para devolver todos de uma vez. */
export class FieldReader {
  readonly errors: string[] = [];
  constructor(private readonly source: JsonObject) {}

  text(field: string): string {
    const value = this.source[field];
    if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT) {
      this.errors.push(`${field}: string obrigatória (1..${String(MAX_TEXT)} caracteres)`);
      return '';
    }
    return value;
  }

  optionalText(field: string): string | undefined {
    const value = this.source[field];
    if (value === undefined || value === null) return undefined;
    return this.text(field);
  }

  uuid(field: string): string {
    const value = this.source[field];
    if (typeof value !== 'string' || !UUID.test(value)) {
      this.errors.push(`${field}: UUID obrigatório`);
      return '';
    }
    return value.toLowerCase();
  }

  money(field: string): Money | undefined {
    const value = this.source[field];
    if (!isObject(value)) {
      this.errors.push(`${field}: objeto { amount, currency } obrigatório`);
      return undefined;
    }
    try {
      // Restrição #1: amount é string decimal; number é recusado.
      return Money.fromInput({
        amount: value.amount as string,
        currency: value.currency as string,
      });
    } catch (error: unknown) {
      this.errors.push(`${field}: ${error instanceof DomainError ? error.message : 'inválido'}`);
      return undefined;
    }
  }

  kind(field: string): WagerTransactionKind {
    const value = this.source[field];
    const kind = SUBMITTABLE_KINDS.find((k) => k === value);
    if (kind === undefined) {
      this.errors.push(`${field}: um de ${SUBMITTABLE_KINDS.join(', ')}`);
      return SUBMITTABLE_KINDS[0] as WagerTransactionKind;
    }
    return kind;
  }

  assertValid(context: string): void {
    if (this.errors.length > 0) throw new InvalidPayloadError(`${context} inválido`, this.errors);
  }
}

/** Campos de negócio de uma transação (corpo HTTP ou `data` da mensagem SQS). */
export function parseWagerFields(
  source: unknown,
  idempotencyKey: string,
  context: string,
): SubmitWagerCommand {
  if (!isObject(source)) throw new InvalidPayloadError(`${context}: objeto JSON esperado`);
  const r = new FieldReader(source);
  const command = {
    providerId: r.text('providerId'),
    externalTransactionId: r.text('externalTransactionId'),
    playerId: r.uuid('playerId'),
    walletId: r.uuid('walletId'),
    roundId: r.text('roundId'),
    gameId: r.text('gameId'),
    kind: r.kind('kind'),
    money: r.money('money'),
    referenceExternalTransactionId: r.optionalText('referenceExternalTransactionId'),
  };
  r.assertValid(context);
  if (command.money === undefined) throw new InvalidPayloadError(`${context}: money inválido`);
  return { ...command, money: command.money, idempotencyKey };
}

export function parseIdempotencyKey(value: unknown, field = 'Idempotency-Key'): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT) {
    throw new InvalidPayloadError(`${field} obrigatório`, [
      `${field}: 1..${String(MAX_TEXT)} caracteres`,
    ]);
  }
  return value;
}
