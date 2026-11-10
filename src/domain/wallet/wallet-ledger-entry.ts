import { Money } from '../money';
import { LedgerDirection } from './ledger-direction';
import { InvalidLedgerEntryError } from './wallet-errors';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** versão da wallet DEPOIS deste lançamento */
  walletVersion: number;
  createdAt: Date;
}

/** Estado persistido; mesma forma do create, mas a reidratação não revalida. */
export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento do ledger: um fato contábil que aconteceu e nunca muda.
 *
 * A imutabilidade é estrutural:
 *  - todos os campos são `readonly`;
 *  - não existe nenhum método que altere estado;
 *  - a instância é congelada (Object.freeze).
 *
 * O banco reforça isso com o trigger append-only da tabela.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Cria um lançamento novo. Valida moeda, sinais e a aritmética before ± money = after. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;

    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError('money, balanceBefore and balanceAfter must share the same currency');
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError('money must be positive');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('balances must not be negative');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError('walletVersion must be an integer >= 1');
    }

    const entry = WalletLedgerEntry.build(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `${balanceBefore} ${props.direction === LedgerDirection.Credit ? '+' : '-'} ${money} != ${balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir do banco. Não revalida: o estado já foi validado ao ser criado. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito com sinal sobre o saldo: +money para crédito, -money para débito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  private static build(p: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      p.id,
      p.walletId,
      p.transactionId,
      p.direction,
      p.money,
      p.balanceBefore,
      p.balanceAfter,
      p.walletVersion,
      new Date(p.createdAt.getTime()), // cópia defensiva: Date é mutável
    );
  }
}
