/**
 * JSON canônico: o mesmo dado sempre vira exatamente o mesmo texto.
 *
 * `JSON.stringify` NÃO serve para hash porque a saída depende da ORDEM em que
 * as chaves foram inseridas: { a: 1, b: 2 } e { b: 2, a: 1 } são o mesmo dado,
 * mas viram textos diferentes — e portanto hashes diferentes. Um replay legítimo
 * seria tratado como "payload diferente" (conflito) só porque o provedor, ou
 * outra linguagem, serializou as chaves em outra ordem.
 *
 * Regras (subconjunto do RFC 8785 / JCS, suficiente para os nossos payloads,
 * que só têm strings, booleanos, null, objetos e arrays):
 *  - chaves de objeto ordenadas (ordem de code unit UTF-16, a mesma do `sort()` padrão);
 *  - arrays mantêm a ordem (em array, a ordem É parte do dado);
 *  - sem espaços;
 *  - chaves com `undefined` são omitidas (igual ao JSON.stringify);
 *  - números são recusados: valor monetário é sempre string decimal, e número
 *    em JSON tem armadilhas de representação (1, 1.0, 1e0).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
      }
      if (!isPlainObject(value)) {
        throw new TypeError(`canonicalJson: unsupported object (${value.constructor?.name ?? 'unknown'})`);
      }
      return `{${Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
        .join(',')}}`;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
