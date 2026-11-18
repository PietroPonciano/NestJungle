/**
 * Invariante final de TODOS os testes (enunciado §13):
 *   wallet.balance == saldo reconstruído pelo ledger,
 *   sem lançamento duplicado e sem saldo negativo em nenhum instante.
 * Verificada direto no banco com SQL próprio, independente do código da app.
 */
import { expect } from 'bun:test';
import type { Client } from 'pg';
import { pgClient } from './database';

export interface InvariantReport {
  walletsChecked: number;
  ledgerEntries: number;
}

export async function assertLedgerInvariants(client?: Client): Promise<InvariantReport> {
  const c = client ?? (await pgClient());
  try {
    // 1. Saldo materializado == soma com sinal do ledger, para cada wallet.
    const divergent = await c.query<{ id: string; balance: string; ledger: string }>(`
      SELECT w.id, w.balance::text AS balance,
             COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS ledger
        FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       GROUP BY w.id, w.balance
      HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)`);
    expect(divergent.rows).toEqual([]);

    // 2. Nenhum lançamento duplicado por transação.
    const dup = await c.query(
      'SELECT transaction_id FROM wallet_ledger_entries GROUP BY transaction_id HAVING COUNT(*) > 1',
    );
    expect(dup.rows).toEqual([]);

    // 3. Saldo nunca negativo em nenhum instante (balance_after de todo lançamento).
    const negative = await c.query(
      'SELECT id FROM wallet_ledger_entries WHERE balance_after < 0 OR balance_before < 0',
    );
    expect(negative.rows).toEqual([]);

    // 4. Cadeia contínua: o balance_before de cada lançamento é o balance_after do anterior.
    const broken = await c.query(`
      SELECT id FROM (
        SELECT id, balance_before,
               LAG(balance_after, 1, 0::numeric) OVER (PARTITION BY wallet_id ORDER BY seq) AS prev_after
          FROM wallet_ledger_entries) t
       WHERE balance_before <> prev_after`);
    expect(broken.rows).toEqual([]);

    // 5. Lançamento só para transação PROCESSED (LOSS/REJECTED/PENDING não lançam).
    const orphan = await c.query(`
      SELECT l.id FROM wallet_ledger_entries l JOIN wager_transactions t ON t.id = l.transaction_id
       WHERE t.status <> 'PROCESSED' OR t.kind = 'LOSS'`);
    expect(orphan.rows).toEqual([]);

    const counts = await c.query<{ wallets: string; entries: string }>(
      'SELECT (SELECT COUNT(*) FROM wallets)::text AS wallets, (SELECT COUNT(*) FROM wallet_ledger_entries)::text AS entries',
    );
    return {
      walletsChecked: Number.parseInt(counts.rows[0]?.wallets ?? '0', 10),
      ledgerEntries: Number.parseInt(counts.rows[0]?.entries ?? '0', 10),
    };
  } finally {
    if (client === undefined) await c.end();
  }
}
