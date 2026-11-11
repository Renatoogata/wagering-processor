import type { MoneyProps } from '../money';
import type { LedgerDirection, Wallet, WalletLedgerEntry } from '../wallet';
import { IntegrationEvent, InvalidEventSourceError, type EventContext } from './integration-event';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/**
 * Publicado SOMENTE quando o saldo muda (BET, WIN, REFUND, ROLLBACK, OPENING).
 * LOSS não gera este evento.
 *
 * aggregateId = walletId: o evento é um fato sobre a WALLET ("o saldo agora é X").
 * Consumidores que mantêm uma projeção do saldo agrupam/ordenam por wallet, e o
 * `walletVersion` permite descartar eventos velhos que cheguem fora de ordem
 * (publicação at-least-once não garante ordem).
 *
 * Só aceita o lançamento MAIS RECENTE da wallet (entry.walletVersion === wallet.version):
 * com um lançamento antigo, `balanceAfter` não seria mais o saldo real e o evento mentiria.
 */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidEventSourceError(
        'WalletBalanceChanged',
        `entry ${entry.id} belongs to wallet ${entry.walletId}, not ${wallet.id}`,
      );
    }
    if (entry.walletVersion !== wallet.version) {
      throw new InvalidEventSourceError(
        'WalletBalanceChanged',
        `entry ${entry.id} is version ${entry.walletVersion}, wallet is at ${wallet.version}`,
      );
    }

    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
