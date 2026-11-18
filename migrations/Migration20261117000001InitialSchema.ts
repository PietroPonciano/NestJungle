/**
 * Migration 001 — schema inicial do Distributed Wagering Processor.
 *
 * O bloco UP é cópia VERBATIM de `docs/001_initial_schema.sql` (seção UP).
 * Nenhuma constraint, índice ou trigger foi removido ou enfraquecido:
 * Restrição #9 — unicidade, imutabilidade e não-negatividade garantidas no
 * banco (o teste `migration-schema.test.ts` confere que o SQL aplicado é
 * idêntico ao arquivo de referência).
 *
 * DOWN: os DROPs do bloco DOWN do mesmo arquivo, na mesma ordem.
 * Rodar o UP inteiro numa única transação (MikroORM envolve cada migration em
 * transação) faz o schema subir completo ou não subir.
 */
import { Migration } from '@mikro-orm/migrations';

// Template literal comum (não String.raw): o transpilador do Bun reescreve
// não-ASCII como \uXXXX, e String.raw preservaria o escape literalmente.
// O SQL não contém barras invertidas, então não há escape a interpretar.
export const INITIAL_SCHEMA_UP_SQL = `
-- ---------------------------------------------------------------------
-- wallets: aggregate root. Unidade de concorrência = wallets.id
-- (lock pessimista por linha: SELECT ... FOR UPDATE; nunca lock global).
-- ---------------------------------------------------------------------
CREATE TABLE wallets (
  id          UUID          PRIMARY KEY,                     -- UUID v7 gerado na aplicação
  player_id   UUID          NOT NULL,
  currency    CHAR(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),   -- ISO-4217
  balance     NUMERIC(18,2) NOT NULL CHECK (balance >= 0),   -- saldo nunca negativo, nem sob race
  version     BIGINT        NOT NULL DEFAULT 1 CHECK (version >= 1),    -- inicia em 1; só incrementa quando o saldo muda
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- no máximo uma wallet por jogador+moeda (conflito -> 409 na API)
  CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
);

-- ---------------------------------------------------------------------
-- wager_transactions: toda operação aceita (inclusive REJECTED/FAILED)
-- fica auditável. Guarda payload_hash e o saldo observado para que um
-- replay devolva o RESULTADO ORIGINAL (regra de negócio nº 7).
-- ---------------------------------------------------------------------
CREATE TABLE wager_transactions (
  id                                UUID          PRIMARY KEY,
  provider_id                       TEXT          NOT NULL,
  external_transaction_id           TEXT          NOT NULL,
  idempotency_key                   TEXT          NOT NULL,
  payload_hash                      TEXT          NOT NULL,   -- sha256 do JSON canônico (chaves ordenadas)
  wallet_id                         UUID          NOT NULL REFERENCES wallets(id),
  player_id                         UUID          NOT NULL,
  round_id                          TEXT          NOT NULL,
  game_id                           TEXT          NOT NULL,
  kind                              TEXT          NOT NULL
    CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  status                            TEXT          NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  amount                            NUMERIC(18,2) NOT NULL,
  currency                          CHAR(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- id da transação referenciada NO PROVEDOR (não o id interno)
  reference_external_transaction_id TEXT,
  -- id interno, preenchido quando a referência é resolvida
  reference_transaction_id          UUID          REFERENCES wager_transactions(id),
  failure_code                      TEXT,
  -- saldo da wallet observado quando a transação virou terminal; é o que o
  -- replay devolve (LOSS e REJECTED não têm ledger, então não dá pra derivar do ledger)
  observed_balance                  NUMERIC(18,2),
  -- controle do worker de PENDING_REFERENCE (backoff exponencial + TTL)
  attempts                          INT           NOT NULL DEFAULT 0,
  next_attempt_at                   TIMESTAMPTZ,
  expires_at                        TIMESTAMPTZ,
  processed_at                      TIMESTAMPTZ,
  created_at                        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at                        TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- Idempotência persistente (última linha de defesa contra duplicidade)
  CONSTRAINT uq_tx_provider_external UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT uq_tx_provider_idempotency UNIQUE (provider_id, idempotency_key),

  -- LOSS pode ter valor 0; as demais operações exigem valor positivo
  CONSTRAINT ck_tx_amount CHECK (amount >= 0 AND (kind = 'LOSS' OR amount > 0)),
  -- REFUND e ROLLBACK exigem referência (WIN pode, mas não é obrigatório)
  CONSTRAINT ck_tx_reference_required
    CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  -- REJECTED/FAILED sempre carregam failure_code; os demais estados nunca
  CONSTRAINT ck_tx_failure_code
    CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  -- processed_at só existe em PROCESSED
  CONSTRAINT ck_tx_processed_at
    CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL))
);

-- Decisão D1: no máximo UMA reversão (REFUND ou ROLLBACK) PROCESSED por referência.
-- Permitir um REFUND e um ROLLBACK da mesma BET creditaria duas vezes (viola a invariante global).
CREATE UNIQUE INDEX uq_tx_single_reversal
  ON wager_transactions (reference_transaction_id)
  WHERE reference_transaction_id IS NOT NULL
    AND kind IN ('REFUND','ROLLBACK')
    AND status = 'PROCESSED';

-- Worker de referências pendentes: varre por vencimento do backoff
CREATE INDEX idx_tx_pending_reference_due
  ON wager_transactions (next_attempt_at)
  WHERE status = 'PENDING_REFERENCE';

-- Quando a BET chega, localizar rapidamente quem estava esperando por ela
CREATE INDEX idx_tx_waiting_for_reference
  ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PENDING_REFERENCE';

CREATE INDEX idx_tx_wallet ON wager_transactions (wallet_id);

-- ---------------------------------------------------------------------
-- wallet_ledger_entries: append-only. Fonte de verdade da reconciliação.
-- ---------------------------------------------------------------------
CREATE TABLE wallet_ledger_entries (
  id             UUID          PRIMARY KEY,
  -- seq dá ordenação total e estável para a paginação por cursor opaco
  seq            BIGINT        GENERATED ALWAYS AS IDENTITY UNIQUE,
  wallet_id      UUID          NOT NULL REFERENCES wallets(id),
  transaction_id UUID          NOT NULL REFERENCES wager_transactions(id),
  direction      TEXT          NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount         NUMERIC(18,2) NOT NULL CHECK (amount > 0),   -- LOSS/REJECTED nunca geram lançamento
  currency       CHAR(3)       NOT NULL,
  balance_before NUMERIC(18,2) NOT NULL CHECK (balance_before >= 0),
  balance_after  NUMERIC(18,2) NOT NULL CHECK (balance_after >= 0),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- No máximo um lançamento por wallet por transação financeira
  CONSTRAINT uq_ledger_wallet_tx UNIQUE (wallet_id, transaction_id),
  -- Aritmética do lançamento verificada pelo banco (espelha isBalanced())
  CONSTRAINT ck_ledger_balanced CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
    (direction = 'DEBIT'  AND balance_after = balance_before - amount)
  )
);

CREATE INDEX idx_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq);

-- Imutabilidade estrutural: bloqueia UPDATE/DELETE (por linha) e TRUNCATE
-- (por statement — o trigger FOR EACH ROW sozinho NÃO cobre TRUNCATE).
CREATE FUNCTION block_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries é imutável (% bloqueado)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_immutable_row
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION block_ledger_mutation();

CREATE TRIGGER trg_ledger_immutable_truncate
  BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION block_ledger_mutation();

-- ---------------------------------------------------------------------
-- inbox_messages: deduplicação persistente do consumidor SQS.
-- Gravada na MESMA transação do efeito financeiro. Usar
-- INSERT ... ON CONFLICT DO NOTHING (um erro de UNIQUE abortaria a
-- transação inteira no PostgreSQL).
-- ---------------------------------------------------------------------
CREATE TABLE inbox_messages (
  consumer_name TEXT        NOT NULL,
  message_id    TEXT        NOT NULL,
  payload_hash  TEXT        NOT NULL,   -- mesmo messageId com payload diferente = conflito, não replay
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  PRIMARY KEY (consumer_name, message_id)
);

-- ---------------------------------------------------------------------
-- outbox_messages: eventos gravados na mesma transação do efeito.
-- Publishers concorrentes usam FOR UPDATE SKIP LOCKED.
-- ---------------------------------------------------------------------
CREATE TABLE outbox_messages (
  id              UUID        PRIMARY KEY,   -- = eventId do envelope
  aggregate_id    UUID        NOT NULL,
  event_type      TEXT        NOT NULL,
  payload         JSONB       NOT NULL,      -- envelope serializado (MoneyProps como string decimal)
  occurred_at     TIMESTAMPTZ NOT NULL,
  attempts        INT         NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),   -- backoff
  published_at    TIMESTAMPTZ,
  last_error      TEXT
);

-- Só os pendentes entram no índice; serve de base para a métrica de outbox lag
CREATE INDEX idx_outbox_pending ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
`;

export class Migration20261117000001InitialSchema extends Migration {
  override up(): void {
    this.addSql(INITIAL_SCHEMA_UP_SQL);
  }

  override down(): void {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_immutable_truncate ON wallet_ledger_entries;');
    this.addSql('DROP TRIGGER IF EXISTS trg_ledger_immutable_row ON wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP FUNCTION IF EXISTS block_ledger_mutation();');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
  }
}
