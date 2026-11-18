import { describe, expect, test } from 'bun:test';
import {
  FAILURE_CODES,
  FailureCategory,
  FailureCode,
} from '../../src/domain/wager-transaction/failure-code';

describe('Taxonomia de failureCode', () => {
  test('todo código tem especificação, e os valores são estáveis (iguais ao nome do contrato)', () => {
    for (const code of Object.values(FailureCode)) {
      expect(FAILURE_CODES[code]).toBeDefined();
      expect(code).toMatch(/^[A-Z_]+$/);
    }
  });

  test('negócio (REJECTED/422) × permanente (FAILED/500)', () => {
    const permanent = Object.values(FailureCode).filter(
      (c) => FAILURE_CODES[c].category === FailureCategory.Permanent,
    );
    expect(permanent.map(String).sort()).toEqual([
      'INTERNAL_PERMANENT_ERROR',
      'RETRY_LIMIT_EXCEEDED',
    ]);
  });

  test('sem códigos de duplicata, de transitório, WALLET_NOT_FOUND ou INVALID_PAYLOAD (D7)', () => {
    const codes: string[] = Object.values(FailureCode);
    for (const forbidden of ['DUPLICATE', 'TRANSIENT', 'WALLET_NOT_FOUND', 'INVALID_PAYLOAD']) {
      expect(codes.some((c) => c.includes(forbidden))).toBe(false);
    }
  });

  test('REVERSAL_WOULD_OVERDRAW é distinto de INSUFFICIENT_FUNDS (regra 9)', () => {
    expect(FailureCode.ReversalWouldOverdraw).not.toBe(FailureCode.InsufficientFunds);
  });
});
