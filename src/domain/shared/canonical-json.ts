/**
 * JSON canônico (base do payloadHash, guia §6.3).
 *
 * Invariantes:
 *  - Determinístico: o mesmo valor lógico sempre produz a mesma string,
 *    independentemente da ordem de inserção das chaves.
 *  - Chaves de objetos ordenadas recursivamente pela ordem de code unit UTF-16
 *    (o `sort()` padrão do JS), sem espaços nem quebras de linha.
 *  - Propriedades `undefined` são omitidas (campos opcionais ausentes não
 *    alteram o hash). Arrays preservam a ordem.
 *  - Só aceita tipos JSON. Valores monetários devem entrar como string decimal
 *    (Restrição #1), nunca como number.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue | undefined };

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('JSON canônico não aceita NaN/Infinity');
    }
    return JSON.stringify(value);
  }
  if (isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
  }
  return `{${parts.join(',')}}`;
}

function isArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}
