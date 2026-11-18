/** Validação de parâmetros HTTP (path, query, corpo de wallet, cursor opaco). */
import { InvalidPayloadError } from '../../application/errors';
import type { CreateWalletCommand } from '../../application/use-cases/create-wallet';
import { FieldReader, isObject } from '../shared/payload-parsers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path params UUID: sem isso, um id malformado viraria erro 22P02 do banco (500). */
export function parseUuidParam(value: string, name: string): string {
  if (!UUID.test(value)) throw new InvalidPayloadError(`${name} deve ser UUID`);
  return value.toLowerCase();
}

export function parseCreateWallet(body: unknown): CreateWalletCommand {
  if (!isObject(body)) throw new InvalidPayloadError('Corpo deve ser objeto JSON');
  const r = new FieldReader(body);
  const playerId = r.uuid('playerId');
  const initialBalance = r.money('initialBalance');
  r.assertValid('Corpo');
  if (initialBalance === undefined) throw new InvalidPayloadError('initialBalance inválido');
  return { playerId, initialBalance };
}

// Cursor opaco e estável: base64url de {"seq":"<n>"}. O cliente não deve
// interpretá-lo; o formato pode mudar sem quebrar o contrato.
export function encodeCursor(seq: string | undefined): string | null {
  return seq === undefined
    ? null
    : Buffer.from(JSON.stringify({ seq }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (isObject(parsed) && typeof parsed.seq === 'string' && /^\d{1,19}$/.test(parsed.seq)) {
      return parsed.seq;
    }
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidPayloadError('cursor inválido');
}

export function parseLimit(value: string | undefined, fallback = 50, max = 200): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value))
    throw new InvalidPayloadError(`limit deve ser inteiro entre 1 e ${String(max)}`);
  const n = Number.parseInt(value, 10);
  if (n < 1 || n > max)
    throw new InvalidPayloadError(`limit deve ser inteiro entre 1 e ${String(max)}`);
  return n;
}
