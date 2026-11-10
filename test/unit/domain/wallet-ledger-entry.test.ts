import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
} from '../../../src/domain/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const props = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('75.00'),
  walletVersion: 2,
  createdAt: new Date('2026-11-10T12:00:00Z'),
  ...overrides,
});

describe('WalletLedgerEntry.create', () => {
  test('aceita débito balanceado', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().amount).toBe('-25.00');
  });

  test('aceita crédito balanceado', () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceBefore: brl('75.00'), balanceAfter: brl('100.00') }),
    );
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().amount).toBe('25.00');
  });

  test.each([
    ['aritmética errada', props({ balanceAfter: brl('80.00') })],
    ['direção trocada', props({ direction: LedgerDirection.Credit })],
    ['valor zero', props({ money: brl('0.00'), balanceAfter: brl('100.00') })],
    ['saldo final negativo', props({ balanceBefore: brl('10.00'), balanceAfter: brl('0.00').subtract(brl('15.00')) })],
    ['versão zero', props({ walletVersion: 0 })],
    ['versão fracionária', props({ walletVersion: 1.5 })],
    ['moedas diferentes', props({ money: Money.from({ amount: '25.00', currency: 'USD' }) })],
  ])('rejeita %s', (_label, invalid) => {
    expect(() => WalletLedgerEntry.create(invalid)).toThrow(InvalidLedgerEntryError);
  });
});

describe('WalletLedgerEntry: imutabilidade estrutural', () => {
  test('a instância é congelada', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('999.00');
    }).toThrow();
  });

  test('não expõe métodos de transição', () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['isBalanced', 'signedAmount']);
  });

  test('alterar a Date original não altera o lançamento (cópia defensiva)', () => {
    const createdAt = new Date('2026-11-10T12:00:00Z');
    const entry = WalletLedgerEntry.create(props({ createdAt }));
    createdAt.setFullYear(2000);
    expect(entry.createdAt.getUTCFullYear()).toBe(2026);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('reconstrói sem revalidar', () => {
    // um registro "estranho" vindo do banco não derruba a leitura;
    // quem audita isso é a reconciliação, não a reidratação
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl('80.00') }));
    expect(entry.isBalanced()).toBe(false);
  });
});
