import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
  Money,
} from '../../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from: entradas válidas', () => {
  test.each(['0.00', '0.01', '25.00', '1000.00', '999999999999999999.99'])('aceita "%s"', (amount) => {
    expect(brl(amount).amount).toBe(amount);
  });

  test('preserva a moeda', () => {
    expect(usd('1.00').currency).toBe('USD');
  });
});

describe('Money.from: entradas inválidas', () => {
  test.each([
    ['string vazia', ''],
    ['sem casas decimais', '25'],
    ['uma casa decimal', '25.0'],
    ['mais de 2 casas', '25.001'],
    ['mais de 2 casas (zeros)', '25.000'],
    ['notação científica', '1e3'],
    ['notação científica com ponto', '2.50e1'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['zeros à esquerda', '007.00'],
    ['sinal de mais', '+25.00'],
    ['espaços', ' 25.00 '],
    ['vírgula decimal', '25,00'],
    ['separador de milhar', '1,000.00'],
    ['ponto sem parte inteira', '.50'],
    ['hexadecimal', '0x10'],
    ['mais de 18 dígitos inteiros', '1000000000000000000.00'],
  ])('rejeita %s ("%s")', (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyAmountError);
  });

  test('rejeita valor negativo com motivo específico', () => {
    expect(() => brl('-25.00')).toThrow(/must not be negative/);
  });

  test.each([
    ['number', 25],
    ['float', 25.5],
    ['NaN numérico', Number.NaN],
    ['Infinity numérico', Number.POSITIVE_INFINITY],
    ['null', null],
    ['undefined', undefined],
    ['bigint', 2500n],
  ])('rejeita amount do tipo %s', (_label, amount) => {
    expect(() => Money.from({ amount: amount as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyAmountError,
    );
  });

  test('rejeita props que não são objeto', () => {
    expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(
      InvalidMoneyAmountError,
    );
  });

  test.each(['', 'brl', 'BR', 'BRLL', 'R$', '123', ' BRL'])('rejeita moeda "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidCurrencyError);
  });

  test('erros carregam code estável', () => {
    expect(() => brl('abc')).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
    expect(() => Money.zero('xx')).toThrow(expect.objectContaining({ code: 'INVALID_CURRENCY' }));
  });
});

describe('Money: arredondamento e precisão', () => {
  test('0.10 + 0.20 é exatamente 0.30 (o clássico bug do float)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
  });

  test('nunca arredonda: 25.005 é rejeitado, não vira 25.01 nem 25.00', () => {
    expect(() => brl('25.005')).toThrow(InvalidMoneyAmountError);
  });

  test('valores acima de Number.MAX_SAFE_INTEGER continuam exatos', () => {
    // 2^53 = 9007199254740992; em centavos isso estoura o float, em bigint não
    const big = brl('90071992547409.93');
    expect(big.add(brl('0.01')).amount).toBe('90071992547409.94');
  });

  test('somar 0.01 mil vezes dá exatamente 10.00', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
    expect(total.amount).toBe('10.00');
  });

  test('resultado acima do limite da coluna é rejeitado', () => {
    expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow(InvalidMoneyAmountError);
  });
});

describe('Money: aritmética', () => {
  test('add', () => {
    expect(brl('100.00').add(brl('25.50')).amount).toBe('125.50');
  });

  test('subtract', () => {
    expect(brl('100.00').subtract(brl('80.00')).amount).toBe('20.00');
  });

  test('subtract pode produzir negativo (ex.: diferença de reconciliação)', () => {
    const diff = brl('20.00').subtract(brl('80.00'));
    expect(diff.amount).toBe('-60.00');
    expect(diff.isNegative()).toBe(true);
  });

  test('negativo com centavos é formatado corretamente', () => {
    expect(brl('0.00').subtract(brl('0.05')).amount).toBe('-0.05');
  });

  test('negate', () => {
    expect(brl('25.00').negate().amount).toBe('-25.00');
    expect(brl('25.00').negate().negate().amount).toBe('25.00');
  });

  test('negate de zero continua zero (sem "-0.00")', () => {
    expect(Money.zero('BRL').negate().amount).toBe('0.00');
  });
});

describe('Money: imutabilidade', () => {
  test('operações retornam nova instância e não alteram a original', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('15.00');
    expect(b).not.toBe(a);
  });

  test('a instância é congelada', () => {
    const m = brl('10.00');
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      (m as unknown as { currency: string }).currency = 'USD';
    }).toThrow();
  });
});

describe('Money: comparações', () => {
  test('isZero / isPositive / isNegative', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.zero('BRL').isNegative()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
  });

  test('isLessThan / isGreaterThan', () => {
    expect(brl('20.00').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80.01').isGreaterThan(brl('80.00'))).toBe(true);
  });

  test('equals compara valor e moeda', () => {
    expect(brl('25.00').equals(brl('25.00'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
    expect(brl('25.00').equals(usd('25.00'))).toBe(false);
  });
});

describe('Money: conflito de moeda', () => {
  test.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
    ['isGreaterThan', (a: Money, b: Money) => a.isGreaterThan(b)],
  ])('%s entre BRL e USD lança CurrencyMismatchError', (_name, op) => {
    expect(() => op(brl('10.00'), usd('10.00'))).toThrow(CurrencyMismatchError);
  });

  test('o erro informa as moedas e tem code estável', () => {
    try {
      brl('1.00').add(usd('1.00'));
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(CurrencyMismatchError);
      const e = error as CurrencyMismatchError;
      expect(e.code).toBe('CURRENCY_MISMATCH');
      expect(e.expected).toBe('BRL');
      expect(e.actual).toBe('USD');
    }
  });
});

describe('Money: serialização', () => {
  test('toJSON devolve MoneyProps com string decimal', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test('JSON.stringify usa toJSON (nunca vaza bigint nem number)', () => {
    expect(JSON.stringify({ money: brl('975.00') })).toBe('{"money":{"amount":"975.00","currency":"BRL"}}');
  });

  test('ida e volta: from(toJSON()) é igual ao original', () => {
    const original = brl('1234.56');
    expect(Money.from(original.toJSON()).equals(original)).toBe(true);
  });

  test('toString', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
  });

  test('zero', () => {
    expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });
});
