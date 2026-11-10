import { CurrencyMismatchError, Money } from "../money";
import { LedgerDirection } from "./ledger-direction";
import { WalletLedgerEntry } from "./wallet-ledger-entry";
import {
  InsufficientBalanceError,
  InvalidInitialBalanceError,
  NonPositiveAmountError,
} from "./wallet-errors";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** id da transação interna OPENING (usado só se initialBalance > 0) */
  openingTransactionId: string;
  /** id do lançamento de abertura (usado só se initialBalance > 0) */
  openingEntryId: string;
  at: Date;
}

export interface OpenWalletResult {
  wallet: Wallet;
  /** lançamento CREDIT de abertura; ausente quando o saldo inicial é zero */
  openingEntry?: WalletLedgerEntry;
}

/** Dados de uma movimentação. Os ids vêm de fora (IdGenerator), o que deixa o domínio determinístico. */
export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate Root da carteira.
 *
 * Invariantes protegidas aqui (e repetidas no schema do banco):
 *  - saldo nunca negativo;
 *  - toda mudança de saldo produz exatamente um lançamento, e todo lançamento
 *    vem de uma mudança de saldo: credit/debit fazem as duas coisas juntas;
 *  - a moeda da operação é a moeda da wallet;
 *  - version começa em 1 e incrementa somente quando o saldo muda.
 *
 * A Wallet NÃO resolve concorrência: isso é papel do repositório/caso de uso
 * (lock da linha no banco). Ela garante que cada operação, isoladamente, é correta.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  // ------------------------------------------------------------- factories

  static open(props: OpenWalletProps): OpenWalletResult {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidInitialBalanceError(initialBalance.amount);
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      new Date(at.getTime()),
      new Date(at.getTime()),
    );

    if (initialBalance.isZero()) {
      return { wallet };
    }

    // O saldo inicial "nasce" de um crédito que parte do zero, na versão 1.
    // É exatamente o que o trigger ledger_chain do banco espera do primeiro lançamento.
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: wallet.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: at,
    });

    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência: não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  // ------------------------------------------------------------- getters

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  // ------------------------------------------------------------- comportamento

  /** Adiciona dinheiro e devolve o lançamento CREDIT correspondente. */
  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(movement.money);

    return this.apply(
      LedgerDirection.Credit,
      movement,
      balanceBefore,
      balanceAfter,
    );
  }

  /**
   * Retira dinheiro e devolve o lançamento DEBIT correspondente.
   * Lança InsufficientBalanceError se o saldo não cobrir o valor
   * (e, nesse caso, a wallet NÃO é alterada).
   */
  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);

    const balanceBefore = this._balance;

    if (balanceBefore.isLessThan(movement.money)) {
      throw new InsufficientBalanceError(
        this.id,
        balanceBefore.amount,
        movement.money.amount,
      );
    }

    const balanceAfter = balanceBefore.subtract(movement.money);

    return this.apply(
      LedgerDirection.Debit,
      movement,
      balanceBefore,
      balanceAfter,
    );
  }

  canAfford(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: new Date(this.createdAt.getTime()),
      updatedAt: new Date(this._updatedAt.getTime()),
    };
  }

  // ------------------------------------------------------------- internos

  /**
   * Único ponto onde o saldo muda.
   * Cria o lançamento ANTES de alterar o estado: se a criação falhar,
   * a wallet continua exatamente como estava.
   */
  private apply(
    direction: LedgerDirection,
    movement: WalletMovement,
    balanceBefore: Money,
    balanceAfter: Money,
  ): WalletLedgerEntry {
    const nextVersion = this._version + 1;

    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      walletVersion: nextVersion,
      createdAt: movement.at,
    });

    this._balance = balanceAfter;
    this._version = nextVersion;
    this._updatedAt = new Date(movement.at.getTime());

    return entry;
  }

  private assertValidMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new NonPositiveAmountError(money.amount);
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
