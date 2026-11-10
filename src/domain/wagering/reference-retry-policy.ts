export interface ReferenceRetryPolicyOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

/**
 * Quando tentar de novo resolver uma referência que ainda não chegou (seção 7.1).
 *
 * Backoff exponencial: base * 2^(tentativa-1), limitado a maxDelayMs.
 * Default: 1s, 2s, 4s, ... até 5 min por espera, no máximo 12 tentativas,
 * o que dá cerca de 25 minutos de janela no total.
 *
 * Por que essa janela: entrega fora de ordem em filas costuma resolver em segundos;
 * 25 min cobre também um provedor ou uma fila parados por alguns minutos,
 * sem deixar o jogador esperando por horas um REFUND que nunca vai acontecer.
 *
 * Sem jitter (aleatoriedade) de propósito: deixa o cálculo determinístico e testável.
 * Como várias instâncias leem a mesma tabela com SKIP LOCKED, não há "rajada"
 * de tentativas simultâneas para a mesma transação.
 */
export class ReferenceRetryPolicy {
  static readonly DEFAULT: ReferenceRetryPolicyOptions = {
    baseDelayMs: 1_000,
    maxDelayMs: 5 * 60_000,
    maxAttempts: 12,
  };

  private readonly options: ReferenceRetryPolicyOptions;

  constructor(options: Partial<ReferenceRetryPolicyOptions> = {}) {
    this.options = { ...ReferenceRetryPolicy.DEFAULT, ...options };
  }

  /**
   * @param attemptsSoFar quantas vezes a referência já foi procurada sem sucesso
   * @returns a data da próxima tentativa, ou `undefined` se o limite acabou
   */
  nextAttemptAt(attemptsSoFar: number, now: Date): Date | undefined {
    if (attemptsSoFar >= this.options.maxAttempts) return undefined;
    const exponential = this.options.baseDelayMs * 2 ** attemptsSoFar;
    const delay = Math.min(exponential, this.options.maxDelayMs);
    return new Date(now.getTime() + delay);
  }
}
