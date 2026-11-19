import { describe, expect, test } from 'bun:test';
import { parseRedriveMaxReceiveCount } from '../../src/infrastructure/messaging/redrive-policy';

describe('parseRedriveMaxReceiveCount', () => {
  test('lê o valor como a AWS devolve (string) e como número', () => {
    expect(
      parseRedriveMaxReceiveCount('{"deadLetterTargetArn":"arn:aws:sqs:x","maxReceiveCount":"5"}'),
    ).toBe(5);
    expect(parseRedriveMaxReceiveCount('{"maxReceiveCount":3}')).toBe(3);
  });

  test('ausente, vazio ou malformado -> undefined (o consumidor mantém a config)', () => {
    for (const raw of [undefined, '', '   ', 'não é json', 'null', '[]', '{}', '"5"']) {
      expect(parseRedriveMaxReceiveCount(raw)).toBeUndefined();
    }
  });

  test('valores inválidos -> undefined', () => {
    for (const value of ['"0"', '0', '"-1"', '-1', '"2.5"', '2.5', '"abc"', 'true', 'null']) {
      expect(parseRedriveMaxReceiveCount(`{"maxReceiveCount":${value}}`)).toBeUndefined();
    }
  });
});
