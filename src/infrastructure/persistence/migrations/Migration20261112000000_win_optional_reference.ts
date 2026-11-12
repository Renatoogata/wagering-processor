import { Migration } from '@mikro-orm/migrations';

/**
 * WIN pode trazer referência à BET (seção 7: "WIN pode referenciar a BET da mesma rodada").
 *
 * Interpretação: a referência do WIN é INFORMATIVA. Fica gravada para auditoria
 * (reference_external_transaction_id), mas não é resolvida (reference_transaction_id
 * continua NULL) e não bloqueia o crédito: o prêmio não depende da BET para ser pago.
 *
 * REFUND/ROLLBACK continuam OBRIGADOS a ter referência; BET e LOSS continuam proibidos.
 */
export class Migration20261112000000_win_optional_reference extends Migration {
  override name = 'Migration20261112000000_win_optional_reference';

  override up(): void {
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT ck_wager_tx_reference_required`);
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_tx_reference_required CHECK (
        CASE
          WHEN kind IN ('REFUND','ROLLBACK') THEN reference_external_transaction_id IS NOT NULL
          WHEN kind = 'WIN' THEN true
          ELSE reference_external_transaction_id IS NULL
        END
      )`);
  }

  override down(): void {
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT ck_wager_tx_reference_required`);
    this.addSql(`
      ALTER TABLE wager_transactions ADD CONSTRAINT ck_wager_tx_reference_required CHECK (
        (kind IN ('REFUND','ROLLBACK')) = (reference_external_transaction_id IS NOT NULL)
      )`);
  }
}
