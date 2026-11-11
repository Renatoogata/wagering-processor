/**
 * Relógio e gerador de ids como portas: o caso de uso não chama `new Date()`
 * nem `randomUUID()` direto, então testes podem fixar o tempo e os ids.
 */
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');

export const systemClock: Clock = { now: () => new Date() };

/**
 * UUID v7: começa pelo timestamp, então ids novos são "crescentes".
 * Isso mantém os índices de PK compactos (inserção no fim da árvore B),
 * ao contrário do v4 totalmente aleatório.
 */
export const uuidV7Generator: IdGenerator = { next: () => Bun.randomUUIDv7() };
