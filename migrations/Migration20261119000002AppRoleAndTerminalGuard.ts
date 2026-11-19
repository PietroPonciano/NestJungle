/**
 * Migration 002 — privilégio mínimo da aplicação e imutabilidade de
 * transações terminais (Restrições #5 e #9: garantias no banco, não só no código).
 *
 * 1. Role `wagering_app` (NOLOGIN, de grupo). A aplicação conecta com um login
 *    membro dele (provisionado pelo `migrate` a partir de DATABASE_APP_USER /
 *    DATABASE_APP_PASSWORD). Esse login NÃO é dono das tabelas nem superusuário,
 *    então não consegue `ALTER TABLE ... DISABLE TRIGGER`, `DROP TRIGGER`,
 *    `UPDATE`/`DELETE`/`TRUNCATE` no ledger nem `DELETE` em transações.
 *    O dono das tabelas continua sendo o usuário de migração.
 * 2. Trigger em `wager_transactions`:
 *    - linha em estado terminal (PROCESSED, REJECTED, FAILED) não muda mais —
 *      é dela que o replay devolve o resultado original (regra 7);
 *    - a identidade e o payload (provider, ids, key, hash, wallet, player,
 *      rodada, jogo, kind, valor, moeda, referência externa, created_at) nunca
 *      mudam, em estado nenhum;
 *    - DELETE e TRUNCATE são bloqueados (auditoria).
 *
 * Novas tabelas em migrations futuras precisam de GRANT explícito para
 * `wagering_app` (sem default privileges: cada permissão é deliberada).
 *
 * DOWN: remove triggers/função e revoga as permissões deste banco. O role não
 * é removido: roles são do cluster e podem estar em uso por outros bancos
 * (ex.: `wagering` e `wagering_test` no mesmo PostgreSQL).
 */
import { Migration } from '@mikro-orm/migrations';

export const APP_ROLE = 'wagering_app';

export const APP_ROLE_AND_TERMINAL_GUARD_UP_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    CREATE ROLE ${APP_ROLE} NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
GRANT SELECT, INSERT, UPDATE ON wallets, wager_transactions, inbox_messages, outbox_messages TO ${APP_ROLE};
-- Ledger append-only também por permissão: sem UPDATE, DELETE nem TRUNCATE.
GRANT SELECT, INSERT ON wallet_ledger_entries TO ${APP_ROLE};

CREATE FUNCTION guard_wager_transaction_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
    RAISE EXCEPTION 'wager_transactions % está em estado terminal (%) e é imutável', OLD.id, OLD.status;
  END IF;
  IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
      NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
      NEW.reference_external_transaction_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
      OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
      OLD.reference_external_transaction_id, OLD.created_at) THEN
    RAISE EXCEPTION 'wager_transactions %: identidade e payload são imutáveis', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tx_guard_update
  BEFORE UPDATE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_wager_transaction_update();

CREATE FUNCTION block_wager_transaction_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wager_transactions é auditável (% bloqueado)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tx_no_delete
  BEFORE DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION block_wager_transaction_removal();

CREATE TRIGGER trg_tx_no_truncate
  BEFORE TRUNCATE ON wager_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION block_wager_transaction_removal();
`;

export class Migration20261119000002AppRoleAndTerminalGuard extends Migration {
  override up(): void {
    this.addSql(APP_ROLE_AND_TERMINAL_GUARD_UP_SQL);
  }

  override down(): void {
    this.addSql('DROP TRIGGER IF EXISTS trg_tx_no_truncate ON wager_transactions;');
    this.addSql('DROP TRIGGER IF EXISTS trg_tx_no_delete ON wager_transactions;');
    this.addSql('DROP TRIGGER IF EXISTS trg_tx_guard_update ON wager_transactions;');
    this.addSql('DROP FUNCTION IF EXISTS block_wager_transaction_removal();');
    this.addSql('DROP FUNCTION IF EXISTS guard_wager_transaction_update();');
    this.addSql(`
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    REVOKE ALL ON wallets, wager_transactions, inbox_messages, outbox_messages, wallet_ledger_entries FROM ${APP_ROLE};
    REVOKE USAGE ON SCHEMA public FROM ${APP_ROLE};
  END IF;
END
$$;`);
  }
}
