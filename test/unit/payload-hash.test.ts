import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/domain/shared/canonical-json';
import {
  computePayloadHash,
  type PayloadHashFields,
} from '../../src/domain/wager-transaction/payload-hash';
import { WagerTransactionKind as K, brl, newTx, openWallet, usd } from '../support/factories';

describe('canonicalJson', () => {
  test('ordena chaves recursivamente e não tem espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: [3, { z: true, y: null }] } })).toBe(
      '{"a":{"c":[3,{"y":null,"z":true}],"d":"x"},"b":1}',
    );
  });

  test('independe da ordem de inserção das chaves', () => {
    expect(canonicalJson({ a: '1', b: '2' })).toBe(canonicalJson({ b: '2', a: '1' }));
  });

  test('omite undefined e preserva UTF-8', () => {
    expect(canonicalJson({ a: undefined, b: 'ção' })).toBe('{"b":"ção"}');
  });

  test('rejeita NaN/Infinity', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
  });
});

describe('computePayloadHash', () => {
  const fields: PayloadHashFields = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: K.Bet,
    money: brl('25.00'),
  };

  test('é o SHA-256 do JSON canônico documentado (vetor de referência)', () => {
    const canonical =
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
      '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
      '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';
    const expected = createHash('sha256').update(canonical, 'utf8').digest('hex');
    expect(computePayloadHash(fields)).toBe(expected);
  });

  test('determinístico e normaliza amount para 2 casas ("25" == "25.00")', () => {
    expect(computePayloadHash(fields)).toBe(computePayloadHash({ ...fields }));
    expect(computePayloadHash({ ...fields, money: brl('25') })).toBe(computePayloadHash(fields));
  });

  test('qualquer campo de negócio diferente muda o hash (payload divergente = conflito)', () => {
    const base = computePayloadHash(fields);
    const variants: Partial<PayloadHashFields>[] = [
      { money: brl('25.01') },
      { money: usd('25.00') },
      { kind: K.Win },
      { roundId: 'round-988' },
      { gameId: 'other' },
      { playerId: 'p2' },
      { walletId: 'w2' },
      { providerId: 'provider-b' },
      { externalTransactionId: 'transaction-124' },
      { referenceExternalTransactionId: 'bet-1' },
    ];
    for (const v of variants) {
      expect(computePayloadHash({ ...fields, ...v })).not.toBe(base);
    }
  });

  test('idempotency key e metadados de transporte não entram no hash', () => {
    const w = openWallet('100.00');
    const a = newTx(w, K.Bet, '10.00', { externalTransactionId: 'x', idempotencyKey: 'k1' });
    const b = newTx(w, K.Bet, '10.00', { externalTransactionId: 'x', idempotencyKey: 'k2' });
    expect(a.payloadHash).toBe(b.payloadHash);
  });

  test('mesma key com payload diferente: matchesPayload falso (conflito, não replay)', () => {
    const w = openWallet('100.00');
    const original = newTx(w, K.Bet, '10.00', { externalTransactionId: 'x', idempotencyKey: 'k' });
    const divergent = newTx(w, K.Bet, '11.00', { externalTransactionId: 'x', idempotencyKey: 'k' });
    expect(original.matchesPayload(divergent.payloadHash)).toBe(false);
    const identical = newTx(w, K.Bet, '10.00', { externalTransactionId: 'x', idempotencyKey: 'k' });
    expect(original.matchesPayload(identical.payloadHash)).toBe(true);
  });
});
