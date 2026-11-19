import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { INITIAL_SCHEMA_UP_SQL } from '../../migrations/Migration20261117000001InitialSchema';
import { pgClient, resetDatabase } from '../support/database';

async function tables(): Promise<string[]> {
  const c = await pgClient();
  try {
    const r = await c.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations' ORDER BY 1",
    );
    return r.rows.map((row) => row.tablename);
  } finally {
    await c.end();
  }
}

describe('Migrations (PostgreSQL real)', () => {
  let orm: MikroORM;
  beforeAll(async () => {
    orm = await resetDatabase();
  });
  afterAll(async () => {
    await orm.close(true);
  });

  test('o UP aplicado é idêntico ao bloco UP de docs/001_initial_schema.sql', async () => {
    const file = await Bun.file(
      new URL('../../docs/001_initial_schema.sql', import.meta.url),
    ).text();
    const up = file
      .split('-- ---------- UP ----------')[1]
      ?.split('-- ---------- DOWN ----------')[0];
    expect(up?.trim()).toBe(INITIAL_SCHEMA_UP_SQL.trim());
  });

  test('up cria as 5 tabelas, triggers e índices; down remove tudo; up de novo funciona', async () => {
    const all = [
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ];
    expect(await tables()).toEqual(all);

    // Reverte TODAS as migrations, uma a uma, na ordem inversa.
    await orm.migrator.down({ to: 0 });
    expect(await tables()).toEqual([]);
    const c = await pgClient();
    try {
      const fn = await c.query(
        "SELECT 1 FROM pg_proc WHERE proname IN ('block_ledger_mutation', 'guard_wager_transaction_update', 'block_wager_transaction_removal')",
      );
      expect(fn.rowCount).toBe(0);
    } finally {
      await c.end();
    }

    await orm.migrator.up();
    expect(await tables()).toEqual(all);
    expect((await orm.migrator.getPending()).length).toBe(0);
  });
});
