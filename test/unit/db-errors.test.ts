/**
 * Classificação de erros do PostgreSQL: transitório (503 / retry, nada gravado)
 * × permanente (FAILED auditável). Classificar errado um problema de
 * infraestrutura como permanente queimaria a idempotency key.
 */
import { describe, expect, test } from 'bun:test';
import { isTransientDbError } from '../../src/infrastructure/persistence/db-errors';

describe('isTransientDbError', () => {
  test.each([
    ['40P01', 'deadlock'],
    ['40001', 'serialization_failure'],
    ['55P03', 'lock_timeout'],
    ['57014', 'statement_timeout'],
    ['08006', 'connection_failure'],
    ['53100', 'disk_full'],
    ['53200', 'out_of_memory'],
    ['53300', 'too_many_connections'],
    ['58030', 'io_error'],
    ['25006', 'read_only (failover)'],
  ])('SQLSTATE %s (%s) é transitório', (code) => {
    expect(isTransientDbError({ code })).toBe(true);
    // MikroORM embrulha o erro do driver em `cause`.
    expect(isTransientDbError({ name: 'DriverException', cause: { code } })).toBe(true);
  });

  test.each([
    ['23505', 'unique_violation'],
    ['23514', 'check_violation'],
    ['22P02', 'invalid_text_representation'],
    ['42P01', 'undefined_table'],
    ['XX001', 'data_corrupted'],
  ])('SQLSTATE %s (%s) NÃO é transitório', (code) => {
    expect(isTransientDbError({ code })).toBe(false);
  });

  test('mensagens de conexão do pg sem SQLSTATE são transitórias', () => {
    for (const message of [
      'Connection terminated unexpectedly',
      'Client has encountered a connection error and is not queryable',
      'Connection ended unexpectedly',
    ]) {
      expect(isTransientDbError(new Error(message))).toBe(true);
    }
    expect(isTransientDbError({ code: 'EHOSTUNREACH' })).toBe(true);
    expect(isTransientDbError(new Error('bug de programação'))).toBe(false);
  });
});
