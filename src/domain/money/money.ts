import { CurrencyMismatchError, InvalidCurrencyError, InvalidMoneyAmountError } from './money-errors';

/** Formato de contrato (HTTP, SQS, eventos, persistência). */
export interface MoneyProps {
  amount: string; // decimal com escala fixa de 2 casas, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

/** Escala fixa do desafio: 2 casas decimais. */
const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE); // 100n

/**
 * Mesmo limite da coluna NUMERIC(20,2): 18 dígitos inteiros.
 * Rejeitar aqui evita aceitar um valor que o banco recusaria depois.
 */
const MAX_INTEGER_DIGITS = 18;
const MAX_ABS_MINOR_UNITS = 10n ** BigInt(MAX_INTEGER_DIGITS + SCALE) - 1n;

/**
 * Formato aceito na entrada, de propósito estrito:
 *  - apenas dígitos, um ponto e exatamente 2 casas ("25.00", "0.05");
 *  - sem sinal, espaços, separador de milhar, notação científica, NaN/Infinity;
 *  - sem zeros à esquerda ("007.00"), para que cada valor tenha UMA representação
 *    (importante para o hash canônico do payload de idempotência).
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Value object monetário imutável.
 *
 * Internamente o valor é um `bigint` em unidades menores (centavos):
 * aritmética inteira, exata, sem float e sem dependência de biblioteca externa.
 * "25.00" é guardado como 2500n.
 *
 * O Money nunca arredonda: um valor com mais de 2 casas é rejeitado,
 * porque arredondar dinheiro silenciosamente é criar ou sumir com centavos.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  // ------------------------------------------------------------- factories

  /**
   * Cria a partir de um contrato de entrada (HTTP, SQS).
   * Rejeita valores negativos: nenhum contrato de entrada tem valor negativo.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyAmountError(props, 'money must be an object { amount, currency }');
    }
    const currency = Money.parseCurrency(props.currency);
    const minorUnits = Money.parseAmount(props.amount);
    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  // ------------------------------------------------------------- aritmética

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinorUnits(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinorUnits(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return Money.ofMinorUnits(-this.minorUnits, this.currency);
  }

  // ------------------------------------------------------------- consultas

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits > other.minorUnits;
  }

  /** Igualdade de valor: mesmo valor E mesma moeda. Moedas diferentes => false (não lança). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  // ------------------------------------------------------------- serialização

  /** Valor como string decimal com 2 casas, ex.: "25.00", "-0.50". */
  get amount(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const integerPart = abs / FACTOR;
    const fractionPart = (abs % FACTOR).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${integerPart}.${fractionPart}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  // ------------------------------------------------------------- internos

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  /** Construção interna a partir de centavos. Aceita negativos (ex.: diferença na reconciliação). */
  private static ofMinorUnits(minorUnits: bigint, currency: string): Money {
    const abs = minorUnits < 0n ? -minorUnits : minorUnits;
    if (abs > MAX_ABS_MINOR_UNITS) {
      throw new InvalidMoneyAmountError(undefined, `result exceeds ${MAX_INTEGER_DIGITS} integer digits`);
    }
    return new Money(minorUnits, currency);
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidCurrencyError(currency);
    }
    return currency;
  }

  private static parseAmount(amount: unknown): bigint {
    if (typeof amount !== 'string') {
      // ex.: { amount: 25 } vindo de um JSON: number é proibido para dinheiro
      throw new InvalidMoneyAmountError(amount, 'amount must be a decimal string, e.g. "25.00"');
    }
    if (amount.startsWith('-')) {
      throw new InvalidMoneyAmountError(amount, 'amount must not be negative');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyAmountError(amount, `amount must match "<digits>.<2 digits>", e.g. "25.00"`);
    }
    const [integerPart = '', fractionPart = ''] = amount.split('.');
    if (integerPart.length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyAmountError(amount, `amount exceeds ${MAX_INTEGER_DIGITS} integer digits`);
    }
    return BigInt(integerPart) * FACTOR + BigInt(fractionPart);
  }
}
