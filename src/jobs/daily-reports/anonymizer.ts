/**
 * Anonimização de texto antes de mandar pra LLM.
 *
 * Mascara PII brasileira recorrente em conversas de WhatsApp/Instagram:
 *   - CPF (com ou sem formatação)
 *   - Telefones (vários formatos br + e164)
 *   - Endereços (logradouro + número, padrões comuns br)
 *   - Nomes de clientes do tenant (lista vinda de customers.name)
 *
 * Falsos positivos são preferíveis a falsos negativos — melhor mascarar
 * demais do que vazar PII pro LLM.
 */

const CPF_REGEX = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;

const PHONE_REGEXES: RegExp[] = [
  /\+?55\s?\(?\d{2}\)?\s?9?\s?\d{4}[-.\s]?\d{4}\b/g,
  /\(?\d{2}\)?\s?9\s?\d{4}[-.\s]?\d{4}\b/g,
  /\b9\d{4}[-.\s]?\d{4}\b/g,
  /\b\d{4}[-.\s]?\d{4}\b/g,
];

const ADDRESS_REGEXES: RegExp[] = [
  /\b(?:R(?:ua)?|Av(?:enida)?|Trav(?:essa)?|Estrada|Estr|Pra[çc]a|Pç|Alameda|Al|Rod(?:ovia)?)\.?\s+[A-ZÀ-Üa-zà-ü0-9][^,\n]{2,80},\s*(?:n[ºo°.]?\s*)?\d{1,5}(?:[\s,]+(?:apto?|ap|bloco|bl|casa|cs|conj|sala|sl)\.?\s*[A-Z0-9-]+)?/gi,
];

const MASK = {
  cpf: '[CPF]',
  phone: '[TEL]',
  address: '[ENDEREÇO]',
  name: '[NOME]',
};

export function anonymize(
  text: string,
  options: { customerNames?: string[] } = {},
): string {
  if (!text) return text;

  let out = text;

  out = out.replace(CPF_REGEX, MASK.cpf);

  for (const rx of PHONE_REGEXES) {
    out = out.replace(rx, MASK.phone);
  }

  for (const rx of ADDRESS_REGEXES) {
    out = out.replace(rx, MASK.address);
  }

  const names = options.customerNames ?? [];
  if (names.length > 0) {
    const sorted = [...new Set(names)]
      .filter((n) => n && n.trim().length >= 3)
      .sort((a, b) => b.length - a.length);

    for (const name of sorted) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(`\\b${escaped}\\b`, 'gi');
      out = out.replace(rx, MASK.name);
    }
  }

  return out;
}
