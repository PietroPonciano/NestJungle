/**
 * Restrição #9: cada constraint, índice único e trigger do schema é atacado
 * DIRETO no banco (sem passar pela aplicação) e deve recusar a escrita.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Client } from 'pg';
import { expectPgError, pgClient, resetDatabase } from '../support/database';

const uuid = (): string => Bun.randomUUIDv7();
const CHECK = '23514';
const UNIQUE = '23505';
const FK = '23503';
const NOT_NULL = '23502';

let orm: MikroORM;
let c: Client;

beforeAll(async () => {
  orm = await resetDatabase();
  c = await pgClient();
});
afterAll(async () => {
  await c.end();
  await orm.close(true);
});

type Row = Record<string, string | number | null>;

function insert(table: string, row: Row): Promise<unknown> {
  const cols = Object.keys(row);
  const params = cols.map((_, i) => `$${i + 1}`).join(',');
  return c.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${params})`, Object.values(row));
}

async function wallet(over: Row = {}): Promise<string> {
  const id = uuid();
  await insert('wallets', { id, player_id: uuid(), currency: 'BRL', balance: '100.00', ...over });
  return String(over.id ?? id);
}

function txRow(walletId: string, over: Row = {}): Row {
  const ext = `ext-${uuid()}`;
  return {
    id: uuid(),
    provider_id: 'provider-a',
    external_transaction_id: ext,
    idempotency_key: `provider-a:${ext}`,
    payload_hash: 'h',
    wallet_id: walletId,
    player_id: uuid(),
    round_id: 'r1',
    game_id: 'g1',
    kind: 'BET',
    status: 'PENDING',
    amount: '10.00',
    currency: 'BRL',
    ...over,
  };
}

async function tx(walletId: string, over: Row = {}): Promise<Row> {
  const row = txRow(walletId, over);
  await insert('wager_transactions', row);
  return row;
}

function ledgerRow(walletId: string, transactionId: string, over: Row = {}): Row {
  return {
    id: uuid(),
    wallet_id: walletId,
    transaction_id: transactionId,
    direction: 'DEBIT',
    amount: '10.00',
    currency: 'BRL',
    balance_before: '100.00',
    balance_after: '90.00',
    ...over,
  };
}

const processed = { status: 'PROCESSED', processed_at: '2026-07-29T15:00:00Z' };

describe('wallets', () => {
  test('ck balance >= 0', async () => {
    const e = await expectPgError(wallet({ balance: '-0.01' }));
    expect(e.code).toBe(CHECK);
    expect(e.constraint).toBe('wallets_balance_check');
  });

  test('ck currency ISO-4217', async () => {
    const e = await expectPgError(wallet({ currency: 'brl' }));
    expect(e.code).toBe(CHECK);
    expect(e.constraint).toBe('wallets_currency_check');
  });

  test('ck version >= 1 e default 1', async () => {
    const e = await expectPgError(wallet({ version: 0 }));
    expect(e.constraint).toBe('wallets_version_check');
    const id = await wallet();
    const r = await c.query<{ version: string }>('SELECT version FROM wallets WHERE id = $1', [id]);
    expect(r.rows[0]?.version).toBe('1');
  });

  test('uq_wallets_player_currency', async () => {
    const player = uuid();
    await wallet({ player_id: player });
    const e = await expectPgError(wallet({ player_id: player }));
    expect(e.code).toBe(UNIQUE);
    expect(e.constraint).toBe('uq_wallets_player_currency');
    // Mesma pessoa em outra moeda é permitido
    await wallet({ player_id: player, currency: 'USD' });
  });

  test('UPDATE que deixaria saldo negativo é recusado (rede de segurança da Restrição #7)', async () => {
    const id = await wallet({ balance: '10.00' });
    const e = await expectPgError(
      c.query('UPDATE wallets SET balance = balance - 10.01 WHERE id = $1', [id]),
    );
    expect(e.constraint).toBe('wallets_balance_check');
  });

  test('NUMERIC(18,2): mais de 16 dígitos inteiros estoura (22003)', async () => {
    const e = await expectPgError(wallet({ balance: '10000000000000000.00' }));
    expect(e.code).toBe('22003');
  });
});

describe('wager_transactions', () => {
  let w: string;
  beforeEach(async () => {
    w = await wallet();
  });

  test('FK wallet_id', async () => {
    const e = await expectPgError(tx(uuid()));
    expect(e.code).toBe(FK);
  });

  test('ck kind', async () => {
    const e = await expectPgError(tx(w, { kind: 'JACKPOT' }));
    expect(e.constraint).toBe('wager_transactions_kind_check');
  });

  test('ck status', async () => {
    const e = await expectPgError(tx(w, { status: 'DONE' }));
    expect(e.constraint).toBe('wager_transactions_status_check');
  });

  test('ck currency', async () => {
    const e = await expectPgError(tx(w, { currency: 'R$' }));
    expect(e.code).toBe(CHECK);
  });

  test('uq_tx_provider_external (idempotência persistente)', async () => {
    const first = await tx(w);
    const e = await expectPgError(
      tx(w, { external_transaction_id: first.external_transaction_id ?? null }),
    );
    expect(e.constraint).toBe('uq_tx_provider_external');
    // Mesmo id externo em outro provedor é permitido
    await tx(w, {
      provider_id: 'provider-b',
      external_transaction_id: first.external_transaction_id ?? null,
    });
  });

  test('uq_tx_provider_idempotency (D5: por provedor)', async () => {
    const first = await tx(w);
    const e = await expectPgError(tx(w, { idempotency_key: first.idempotency_key ?? null }));
    expect(e.constraint).toBe('uq_tx_provider_idempotency');
    await tx(w, { provider_id: 'provider-b', idempotency_key: first.idempotency_key ?? null });
  });

  test('ck_tx_amount: BET 0 e negativo recusados; LOSS 0 aceito (D4)', async () => {
    expect((await expectPgError(tx(w, { amount: '0.00' }))).constraint).toBe('ck_tx_amount');
    expect((await expectPgError(tx(w, { kind: 'LOSS', amount: '-1.00' }))).constraint).toBe(
      'ck_tx_amount',
    );
    await tx(w, { kind: 'LOSS', amount: '0.00' });
  });

  test('ck_tx_reference_required: REFUND/ROLLBACK sem referência; WIN sem referência ok', async () => {
    for (const kind of ['REFUND', 'ROLLBACK']) {
      const e = await expectPgError(tx(w, { kind }));
      expect(e.constraint).toBe('ck_tx_reference_required');
    }
    await tx(w, { kind: 'WIN' });
  });

  test('ck_tx_failure_code: REJECTED/FAILED exigem código; demais estados proíbem', async () => {
    for (const status of ['REJECTED', 'FAILED']) {
      expect((await expectPgError(tx(w, { status }))).constraint).toBe('ck_tx_failure_code');
    }
    expect(
      (await expectPgError(tx(w, { status: 'PENDING', failure_code: 'INSUFFICIENT_FUNDS' })))
        .constraint,
    ).toBe('ck_tx_failure_code');
    await tx(w, { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
  });

  test('ck_tx_processed_at: só e sempre em PROCESSED', async () => {
    expect((await expectPgError(tx(w, { status: 'PROCESSED' }))).constraint).toBe(
      'ck_tx_processed_at',
    );
    expect(
      (await expectPgError(tx(w, { status: 'PENDING', processed_at: '2026-07-29T15:00:00Z' })))
        .constraint,
    ).toBe('ck_tx_processed_at');
    await tx(w, processed);
  });

  test('FK reference_transaction_id', async () => {
    const e = await expectPgError(
      tx(w, {
        kind: 'REFUND',
        reference_external_transaction_id: 'x',
        reference_transaction_id: uuid(),
      }),
    );
    expect(e.code).toBe(FK);
  });

  test('uq_tx_single_reversal (D1): REFUND e ROLLBACK PROCESSED da mesma BET', async () => {
    const bet = await tx(w, processed);
    const ref = {
      reference_external_transaction_id: bet.external_transaction_id ?? null,
      reference_transaction_id: bet.id ?? null,
    };
    await tx(w, { kind: 'REFUND', ...ref, ...processed });
    const e = await expectPgError(tx(w, { kind: 'ROLLBACK', ...ref, ...processed }));
    expect(e.code).toBe(UNIQUE);
    expect(e.constraint).toBe('uq_tx_single_reversal');
    // Reversões REJECTED continuam auditáveis (o índice é parcial)
    await tx(w, { kind: 'REFUND', ...ref, status: 'REJECTED', failure_code: 'ALREADY_REVERSED' });
    await tx(w, { kind: 'ROLLBACK', ...ref, status: 'REJECTED', failure_code: 'ALREADY_REVERSED' });
  });

  test('NOT NULL em campos de identidade', async () => {
    const e = await expectPgError(tx(w, { payload_hash: null }));
    expect(e.code).toBe(NOT_NULL);
  });
});

describe('wallet_ledger_entries', () => {
  let w: string;
  let t: string;
  beforeEach(async () => {
    w = await wallet();
    t = String((await tx(w, processed)).id);
  });

  const ledger = (over: Row = {}) => insert('wallet_ledger_entries', ledgerRow(w, t, over));

  test('lançamento válido é aceito e recebe seq (identity)', async () => {
    await ledger();
    const r = await c.query<{ seq: string }>(
      'SELECT seq FROM wallet_ledger_entries WHERE transaction_id = $1',
      [t],
    );
    expect(Number.parseInt(r.rows[0]?.seq ?? '0', 10)).toBeGreaterThan(0);
  });

  test('seq é GENERATED ALWAYS: valor explícito é recusado', async () => {
    const e = await expectPgError(ledger({ seq: 999 }));
    expect(e.code).toBe('428C9');
  });

  test('FK wallet_id e transaction_id', async () => {
    expect((await expectPgError(ledger({ wallet_id: uuid() }))).code).toBe(FK);
    expect((await expectPgError(ledger({ transaction_id: uuid() }))).code).toBe(FK);
  });

  test('ck direction', async () => {
    expect((await expectPgError(ledger({ direction: 'SIDEWAYS' }))).code).toBe(CHECK);
  });

  test('ck amount > 0 (LOSS/REJECTED nunca lançam)', async () => {
    const e = await expectPgError(
      ledger({ amount: '0.00', balance_before: '100.00', balance_after: '100.00' }),
    );
    expect(e.constraint).toBe('wallet_ledger_entries_amount_check');
  });

  test('ck balance_before >= 0 e balance_after >= 0', async () => {
    const e1 = await expectPgError(
      ledger({ direction: 'CREDIT', balance_before: '-10.00', balance_after: '0.00' }),
    );
    expect(e1.constraint).toBe('wallet_ledger_entries_balance_before_check');
    const e2 = await expectPgError(ledger({ balance_before: '5.00', balance_after: '-5.00' }));
    expect(e2.constraint).toBe('wallet_ledger_entries_balance_after_check');
  });

  test('ck_ledger_balanced: aritmética conferida pelo banco', async () => {
    expect((await expectPgError(ledger({ balance_after: '91.00' }))).constraint).toBe(
      'ck_ledger_balanced',
    );
    expect((await expectPgError(ledger({ direction: 'CREDIT' }))).constraint).toBe(
      'ck_ledger_balanced',
    );
  });

  test('uq_ledger_wallet_tx: no máximo um lançamento por wallet por transação', async () => {
    await ledger();
    const e = await expectPgError(ledger());
    expect(e.constraint).toBe('uq_ledger_wallet_tx');
  });

  test('Restrição #5: UPDATE, DELETE e TRUNCATE no ledger falham', async () => {
    await ledger();
    for (const sql of [
      'UPDATE wallet_ledger_entries SET amount = 1.00',
      'DELETE FROM wallet_ledger_entries',
      'TRUNCATE wallet_ledger_entries',
      'TRUNCATE wallet_ledger_entries CASCADE',
    ]) {
      const e = await expectPgError(c.query(sql));
      expect(e.message).toContain('wallet_ledger_entries é imutável');
    }
    const r = await c.query('SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = $1', [t]);
    expect(r.rowCount).toBe(1);
  });
});

describe('inbox_messages e outbox_messages', () => {
  test('inbox PK (consumer_name, message_id); ON CONFLICT DO NOTHING devolve 0 linhas', async () => {
    const row = { consumer_name: 'c1', message_id: 'm1', payload_hash: 'h' };
    await insert('inbox_messages', row);
    expect((await expectPgError(insert('inbox_messages', row))).code).toBe(UNIQUE);
    const r = await c.query(
      "INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('c1','m1','h') ON CONFLICT DO NOTHING",
    );
    expect(r.rowCount).toBe(0);
    await insert('inbox_messages', { ...row, consumer_name: 'c2' });
  });

  test('outbox PK = eventId; next_attempt_at default now()', async () => {
    const id = uuid();
    const row = {
      id,
      aggregate_id: uuid(),
      event_type: 'X',
      payload: '{}',
      occurred_at: '2026-07-29T15:00:00Z',
    };
    await insert('outbox_messages', row);
    expect((await expectPgError(insert('outbox_messages', row))).code).toBe(UNIQUE);
    const r = await c.query('SELECT next_attempt_at FROM outbox_messages WHERE id = $1', [id]);
    expect(r.rows[0]).toBeDefined();
  });
});
