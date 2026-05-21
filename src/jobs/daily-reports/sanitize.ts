// Sanitiza strings antes de inserir no prompt enviado ao LLM. Mensagens
// vindas do WhatsApp podem chegar com surrogate pairs UTF-16 partidos
// (high surrogate sem low correspondente, ou vice-versa) quando o cliente
// envia um emoji truncado ou colado de outra fonte. O serializador do
// DeepSeek rejeita a request com:
//   400 Failed to parse the request body as JSON:
//   messages[N].content: unexpected end of hex escape at line 1 column NNNNNN
// Removemos os órfãos antes de montar o prompt. Pares válidos (emojis
// completos) passam sem alteração.
const ORPHAN_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeUnicode(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(ORPHAN_SURROGATE_RE, '');
}

// Sanitiza recursivamente todas as strings de um objeto/array antes de
// serializar como JSONB no PostgreSQL — o JSONB rejeita surrogates
// órfãos com "invalid input syntax for type json".
export function sanitizeUnicodeDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(ORPHAN_SURROGATE_RE, '') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeUnicodeDeep(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeUnicodeDeep(v);
    }
    return out as T;
  }
  return value;
}
