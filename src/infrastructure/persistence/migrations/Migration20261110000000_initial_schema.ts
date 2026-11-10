import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial.
 *
 * Princípio: as invariantes financeiras são garantidas PELO BANCO, não só pela aplicação.
 * Mesmo que um bug no código (ou um UPDATE manual) tente violar uma regra, o Postgres recusa.
 *
 *  - dinheiro: NUMERIC(20,2), nunca float;
 *  - unicidade: UNIQUE em wallet (player+moeda), idempotency key, (provider, external id), inbox;
 *  - não-negatividade: CHECK (balance >= 0) em wallet e ledger;
 *  - imutabilidade: triggers bloqueiam UPDATE/DELETE/TRUNCATE no ledger e
 *    qualquer mudança em transações que já estão em estado terminal;
 *  - consistência saldo x ledger: constraint trigger DEFERRED confere, no COMMIT,
 *    que toda mudança de saldo tem o lançamento correspondente.
 */
export class Migration20261110000000_initial_schema extends Migration {
  override name = 'Migration20261110000000_initial_schema';

  override up(): void {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   uuid           NOT NULL,
        currency    char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2)  NOT NULL CHECK (balance >= 0),
        version     integer        NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at  timestamptz    NOT NULL DEFAULT now(),
        updated_at  timestamptz    NOT NULL DEFAULT now(),

        -- no máximo uma wallet por jogador + moeda
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        -- alvo de FKs compostas: garante que transação/ledger usam a moeda da wallet
        CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency)
      )`);

    // ------------------------------------------------------- wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid          PRIMARY KEY,
        provider_id                        text          NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
        external_transaction_id            text          NOT NULL CHECK (length(external_transaction_id) BETWEEN 1 AND 256),
        idempotency_key                    text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
        payload_hash                       char(64)      NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id                          uuid          NOT NULL,
        player_id                          uuid          NOT NULL,
        currency                           char(3)       NOT NULL,
        round_id                           text,
        game_id                            text,
        kind                               text          NOT NULL
          CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                             numeric(20,2) NOT NULL CHECK (amount >= 0),
        reference_external_transaction_id  text,
        reference_transaction_id           uuid,
        status                             text          NOT NULL
          CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                       text          CHECK (failure_code ~ '^[A-Z][A-Z0-9_]*$'),
        -- saldo observado quando a transação foi decidida: permite responder replays
        -- com o resultado ORIGINAL (regra 7.7), mesmo que o saldo já tenha mudado
        observed_balance                   numeric(20,2) CHECK (observed_balance >= 0),
        processed_at                       timestamptz,
        -- controle do worker de PENDING_REFERENCE (backoff exponencial)
        attempts                           integer       NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at                    timestamptz,
        created_at                         timestamptz   NOT NULL DEFAULT now(),
        updated_at                         timestamptz   NOT NULL DEFAULT now(),

        -- idempotência persistente
        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),

        -- moeda da transação = moeda da wallet
        CONSTRAINT fk_wager_tx_wallet FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency),

        -- alvos para FKs compostas (referência e ledger)
        CONSTRAINT uq_wager_tx_id_wallet UNIQUE (id, wallet_id),
        CONSTRAINT uq_wager_tx_id_scope UNIQUE (id, wallet_id, provider_id, round_id),

        -- referência precisa ser do MESMO provider, wallet (=> player e moeda) e rodada
        CONSTRAINT fk_wager_tx_reference FOREIGN KEY
          (reference_transaction_id, wallet_id, provider_id, round_id)
          REFERENCES wager_transactions (id, wallet_id, provider_id, round_id),

        -- OPENING é interno e não tem rodada; os demais exigem rodada e jogo
        CONSTRAINT ck_wager_tx_round_game CHECK (
          kind = 'OPENING' OR (round_id IS NOT NULL AND game_id IS NOT NULL)
        ),
        -- REFUND e ROLLBACK exigem referência; os demais não podem ter
        CONSTRAINT ck_wager_tx_reference_required CHECK (
          (kind IN ('REFUND','ROLLBACK')) = (reference_external_transaction_id IS NOT NULL)
        ),
        CONSTRAINT ck_wager_tx_resolved_reference CHECK (
          reference_transaction_id IS NULL OR kind IN ('REFUND','ROLLBACK')
        ),
        -- operações que movem saldo precisam de valor positivo
        CONSTRAINT ck_wager_tx_amount_positive CHECK (
          kind = 'LOSS' OR amount > 0
        ),
        -- failure_code existe se, e somente se, a transação foi rejeitada ou falhou
        CONSTRAINT ck_wager_tx_failure_code CHECK (
          (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
        ),
        -- transação processada tem data e saldo observado
        CONSTRAINT ck_wager_tx_processed CHECK (
          status <> 'PROCESSED' OR (processed_at IS NOT NULL AND observed_balance IS NOT NULL)
        ),
        -- reversão processada precisa ter a referência resolvida
        CONSTRAINT ck_wager_tx_processed_reversal CHECK (
          status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL
        )
      )`);

    // uma referência só pode ser revertida UMA vez por tipo de operação (regra 7.4)
    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_tx_single_reversal
        ON wager_transactions (reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`);

    // fila do worker de referências pendentes
    this.addSql(`
      CREATE INDEX ix_wager_tx_pending_reference
        ON wager_transactions (next_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);

    // ------------------------------------------------------ wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        -- sequência global, base do cursor estável da paginação
        seq             bigint         GENERATED ALWAYS AS IDENTITY UNIQUE,
        wallet_id       uuid           NOT NULL,
        currency        char(3)        NOT NULL,
        transaction_id  uuid           NOT NULL,
        direction       text           NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount          numeric(20,2)  NOT NULL CHECK (amount > 0),
        balance_before  numeric(20,2)  NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(20,2)  NOT NULL CHECK (balance_after >= 0),
        -- versão da wallet resultante deste lançamento
        wallet_version  integer        NOT NULL CHECK (wallet_version >= 1),
        created_at      timestamptz    NOT NULL DEFAULT now(),

        CONSTRAINT fk_ledger_wallet FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency),
        -- o lançamento pertence à mesma wallet da transação
        CONSTRAINT fk_ledger_transaction FOREIGN KEY (transaction_id, wallet_id)
          REFERENCES wager_transactions (id, wallet_id),

        -- no máximo um lançamento por transação por wallet
        CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id),
        -- cada versão da wallet tem no máximo um lançamento: impossível "bifurcar" o histórico
        CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),

        -- aritmética do lançamento: before ± amount = after
        CONSTRAINT ck_ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      )`);

    this.addSql(`CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq)`);

    // ------------------------------------------------------------- inbox / outbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text         NOT NULL,
        message_id     text         NOT NULL,
        payload_hash   char(64)     NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at    timestamptz  NOT NULL DEFAULT now(),
        processed_at   timestamptz,
        -- deduplicação persistente por (consumidor, mensagem)
        CONSTRAINT pk_inbox PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid         PRIMARY KEY,  -- = eventId
        seq              bigint       GENERATED ALWAYS AS IDENTITY UNIQUE,
        aggregate_id     text         NOT NULL,
        event_type       text         NOT NULL,
        event_version    integer      NOT NULL CHECK (event_version >= 1),
        payload          jsonb        NOT NULL,
        occurred_at      timestamptz  NOT NULL,
        attempts         integer      NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at  timestamptz  NOT NULL DEFAULT now(),
        published_at     timestamptz,
        last_error       text
      )`);

    // o publisher só varre o que está pendente
    this.addSql(`
      CREATE INDEX ix_outbox_pending
        ON outbox_messages (next_attempt_at, seq)
        WHERE published_at IS NULL`);

    // ================================================================= triggers

    // ---- wallets: identidade imutável e versionamento estrito
    this.addSql(`
      CREATE FUNCTION trg_wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'restrict_violation';
        END IF;
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
           IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet identity is immutable' USING ERRCODE = 'restrict_violation';
        END IF;
        -- version incrementa exatamente 1 quando o saldo muda, e só nesse caso
        IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'wallet version must increment by 1 on balance change'
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet version can only change with the balance'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wallets_guard BEFORE UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION trg_wallets_guard()`);

    // ---- wallets: toda mudança de saldo tem lançamento correspondente (checado no COMMIT)
    this.addSql(`
      CREATE FUNCTION trg_wallets_ledger_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (TG_OP = 'INSERT' AND NEW.balance > 0)
           OR (TG_OP = 'UPDATE' AND NEW.balance <> OLD.balance) THEN
          IF NOT EXISTS (
            SELECT 1 FROM wallet_ledger_entries
             WHERE wallet_id = NEW.id
               AND wallet_version = NEW.version
               AND balance_after = NEW.balance
          ) THEN
            RAISE EXCEPTION 'balance change on wallet % (version %) has no matching ledger entry',
              NEW.id, NEW.version USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency
        AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION trg_wallets_ledger_consistency()`);

    // ---- ledger: append-only + encadeamento (before do novo = after do anterior)
    this.addSql(`
      CREATE FUNCTION trg_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END $$`);
    this.addSql(`
      CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION trg_ledger_append_only()`);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION trg_ledger_append_only()`);

    this.addSql(`
      CREATE FUNCTION trg_ledger_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        prev wallet_ledger_entries%ROWTYPE;
      BEGIN
        SELECT * INTO prev FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id
         ORDER BY wallet_version DESC LIMIT 1;
        IF NOT FOUND THEN
          IF NEW.balance_before <> 0 THEN
            RAISE EXCEPTION 'first ledger entry of wallet % must start from zero', NEW.wallet_id
              USING ERRCODE = 'check_violation';
          END IF;
        ELSIF NEW.wallet_version <= prev.wallet_version
           OR NEW.balance_before <> prev.balance_after THEN
          RAISE EXCEPTION 'ledger chain broken for wallet % (expected before=%, version>%)',
            NEW.wallet_id, prev.balance_after, prev.wallet_version
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER ledger_chain BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION trg_ledger_chain()`);

    // ---- wager_transactions: estados terminais congelados, dados de negócio imutáveis
    this.addSql(`
      CREATE FUNCTION trg_wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions cannot be deleted' USING ERRCODE = 'restrict_violation';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager transaction % is terminal (%)', OLD.id, OLD.status
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.status = 'PENDING' AND OLD.status <> 'PENDING' THEN
          RAISE EXCEPTION 'invalid transition % -> PENDING', OLD.status
            USING ERRCODE = 'check_violation';
        END IF;
        IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
            NEW.payload_hash, NEW.wallet_id, NEW.player_id, NEW.currency, NEW.round_id,
            NEW.game_id, NEW.kind, NEW.amount, NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
            OLD.payload_hash, OLD.wallet_id, OLD.player_id, OLD.currency, OLD.round_id,
            OLD.game_id, OLD.kind, OLD.amount, OLD.reference_external_transaction_id, OLD.created_at)
        THEN
          RAISE EXCEPTION 'business fields of wager transaction % are immutable', OLD.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION trg_wager_tx_guard()`);
  }

  override down(): void {
    // ordem inversa; DROP TABLE remove os triggers junto
    this.addSql('DROP TABLE IF EXISTS outbox_messages');
    this.addSql('DROP TABLE IF EXISTS inbox_messages');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries');
    this.addSql('DROP TABLE IF EXISTS wager_transactions');
    this.addSql('DROP TABLE IF EXISTS wallets');
    this.addSql('DROP FUNCTION IF EXISTS trg_wager_tx_guard()');
    this.addSql('DROP FUNCTION IF EXISTS trg_ledger_chain()');
    this.addSql('DROP FUNCTION IF EXISTS trg_ledger_append_only()');
    this.addSql('DROP FUNCTION IF EXISTS trg_wallets_ledger_consistency()');
    this.addSql('DROP FUNCTION IF EXISTS trg_wallets_guard()');
  }
}
