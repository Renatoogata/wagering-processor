import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../../src/domain/money';
import {
  InsufficientBalanceError,
  InvalidInitialBalanceError,
  LedgerDirection,
  NonPositiveAmountError,
  Wallet,
  type WalletLedgerEntry,
} from '../../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const T0 = new Date('2026-11-10T12:00:00Z');
const T1 = new Date('2026-11-10T12:05:00Z');

let seq = 0;
const movement = (amount: string, at = T1) => ({
  entryId: `entry-${++seq}`,
  transactionId: `tx-${seq}`,
  money: brl(amount),
  at,
});

function openWallet(initial = '100.00') {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    at: T0,
  });
}

/** Reconstrói o saldo somando o ledger: a invariante final do desafio. */
function balanceFromLedger(entries: WalletLedgerEntry[]): Money {
  return entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero('BRL'));
}

describe('Wallet.open', () => {
  test('com saldo inicial: versão 1 e lançamento CREDIT de abertura', () => {
    const { wallet, openingEntry } = openWallet('1000.00');

    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('1000.00');
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.transactionId).toBe('tx-opening');
  });

  test('com saldo zero: versão 1 e nenhum lançamento', () => {
    const { wallet, openingEntry } = openWallet('0.00');
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('rejeita saldo inicial negativo', () => {
    expect(() =>
      Wallet.open({
        id: 'w',
        playerId: 'p',
        initialBalance: brl('0.00').subtract(brl('1.00')),
        openingTransactionId: 't',
        openingEntryId: 'e',
        at: T0,
      }),
    ).toThrow(InvalidInitialBalanceError);
  });

  test('a moeda da wallet vem do saldo inicial', () => {
    const { wallet } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: usd('5.00'),
      openingTransactionId: 't',
      openingEntryId: 'e',
      at: T0,
    });
    expect(wallet.currency).toBe('USD');
  });
});

describe('Wallet.credit', () => {
  test('soma ao saldo, incrementa a versão e devolve o lançamento', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.credit(movement('50.00'));

    expect(wallet.balance.amount).toBe('150.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('150.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('funciona a partir de saldo zero', () => {
    const { wallet } = openWallet('0.00');
    wallet.credit(movement('10.00'));
    expect(wallet.balance.amount).toBe('10.00');
    expect(wallet.version).toBe(2);
  });
});

describe('Wallet.debit', () => {
  test('subtrai do saldo, incrementa a versão e devolve o lançamento', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.debit(movement('25.00'));

    expect(wallet.balance.amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('75.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('pode zerar o saldo exatamente', () => {
    const { wallet } = openWallet('80.00');
    wallet.debit(movement('80.00'));
    expect(wallet.balance.amount).toBe('0.00');
  });

  test('saldo insuficiente lança erro e NÃO altera a wallet', () => {
    const { wallet } = openWallet('20.00');

    expect(() => wallet.debit(movement('80.00'))).toThrow(InsufficientBalanceError);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(T0);
  });

  test('um centavo a mais já é insuficiente', () => {
    const { wallet } = openWallet('80.00');
    expect(() => wallet.debit(movement('80.01'))).toThrow(InsufficientBalanceError);
  });

  test('o erro carrega code e valores para diagnóstico', () => {
    const { wallet } = openWallet('20.00');
    expect(() => wallet.debit(movement('80.00'))).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_BALANCE', balance: '20.00', requested: '80.00' }),
    );
  });
});

describe('Wallet: validações comuns a crédito e débito', () => {
  test.each(['credit', 'debit'] as const)('%s rejeita moeda diferente sem alterar a wallet', (op) => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet[op]({ ...movement('1.00'), money: usd('1.00') })).toThrow(CurrencyMismatchError);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test.each(['credit', 'debit'] as const)('%s rejeita valor zero', (op) => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet[op](movement('0.00'))).toThrow(NonPositiveAmountError);
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet: invariante saldo == ledger', () => {
  test('após uma sequência de operações, o saldo é igual à soma do ledger', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const ledger: WalletLedgerEntry[] = [openingEntry!];

    ledger.push(wallet.debit(movement('25.00'))); // 75
    ledger.push(wallet.credit(movement('60.00'))); // 135
    ledger.push(wallet.debit(movement('135.00'))); // 0
    ledger.push(wallet.credit(movement('0.01'))); // 0.01

    // um débito recusado não entra no ledger
    expect(() => wallet.debit(movement('1.00'))).toThrow(InsufficientBalanceError);

    expect(wallet.balance.amount).toBe('0.01');
    expect(balanceFromLedger(ledger).equals(wallet.balance)).toBe(true);
    // version = 1 (abertura) + 4 movimentações aceitas
    expect(wallet.version).toBe(5);
  });

  test('cada lançamento encadeia no anterior (before do novo = after do anterior)', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const ledger = [openingEntry!, wallet.debit(movement('10.00')), wallet.credit(movement('5.00'))];

    for (let i = 1; i < ledger.length; i++) {
      expect(ledger[i]!.balanceBefore.equals(ledger[i - 1]!.balanceAfter)).toBe(true);
      expect(ledger[i]!.walletVersion).toBe(ledger[i - 1]!.walletVersion + 1);
    }
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói o estado persistido sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 17,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(wallet.balance.amount).toBe('42.00');
    expect(wallet.version).toBe(17);
    expect(wallet.updatedAt).toEqual(T1);
  });

  test('toState e rehydrate fazem ida e volta', () => {
    const { wallet } = openWallet('100.00');
    wallet.debit(movement('30.00'));
    const copy = Wallet.rehydrate(wallet.toState());
    expect(copy.toState()).toEqual(wallet.toState());
  });
});
