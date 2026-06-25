import { desenrolaPool } from '../db.js';
import { chatJson } from '../llm.js';
import { utcRangeForBrtDay } from './human-attendance.js';

export interface UnansweredCandidate {
  requestId: string;
  messages: string[];
}

export interface UnansweredVerdict {
  requestId: string;
  needsReply: boolean;
  reason: string;
}

export interface ClassifiedUnanswered {
  candidates: number;
  needsReplyCount: number;
  verdicts: UnansweredVerdict[];
  tokens: { input: number; output: number };
}

const MAX_MSG_LEN = 300;
const MAX_MSGS_PER_CANDIDATE = 15;

/**
 * Clientes (request_id) que mandaram mensagem e NÃO receberam nenhuma resposta
 * (tenant/agent/template) no dia — junto com o que escreveram. São os
 * candidatos a "sem resposta"; o juízo de quais exigiam resposta fica pro LLM.
 */
export async function fetchUnansweredCandidates(
  tenantId: string,
  reportDate: string,
): Promise<UnansweredCandidate[]> {
  const r = utcRangeForBrtDay(reportDate);
  const { rows } = await desenrolaPool.query<{
    request_id: string;
    messages: string[];
  }>(
    `
      WITH answered AS (
        SELECT DISTINCT request_id
        FROM message_logs
        WHERE tenant_id = $1
          AND origin IN ('tenant', 'agent', 'template')
          AND receivad_at >= ${r.start}
          AND receivad_at <  ${r.end}
      )
      SELECT
        um.request_id::text AS request_id,
        array_agg(um.message ORDER BY um.receivad_at) AS messages
      FROM message_logs um
      WHERE um.tenant_id = $1
        AND um.origin = 'user'
        AND btrim(coalesce(um.message, '')) <> ''
        AND um.receivad_at >= ${r.start}
        AND um.receivad_at <  ${r.end}
        AND um.request_id NOT IN (SELECT request_id FROM answered)
      GROUP BY um.request_id
    `,
    [tenantId],
  );

  return rows.map((row) => ({
    requestId: row.request_id,
    messages: row.messages
      .slice(0, MAX_MSGS_PER_CANDIDATE)
      .map((m) => m.slice(0, MAX_MSG_LEN)),
  }));
}

const CLASSIFIER_SYSTEM_PROMPT = `Você classifica conversas de atendimento que ficaram SEM NENHUMA resposta da equipe no dia. Para cada cliente, decida se as mensagens dele EXIGIAM uma resposta que não veio.

needsReply = true quando o cliente trouxe algo que demanda retorno: pergunta, pedido, problema, reclamação, solicitação de ajuda/suporte, dúvida operacional, pedido de status.

needsReply = false quando as mensagens são apenas: saudação solta sem conteúdo ("oi", "boa noite" e nada mais), despedida/agradecimento/confirmação ("ok", "obrigado", "valeu", "👍"), ou um informe que não pede ação nem resposta.

Na dúvida entre os dois, escolha true (é pior ignorar um pedido real do que sinalizar um a mais).

Responda APENAS com JSON válido no formato:
{"results": [{"requestId": "<id>", "needsReply": true|false, "reason": "<motivo curto>"}]}
Inclua TODOS os clientes recebidos, um por requestId.`;

export async function classifyUnanswered(
  candidates: UnansweredCandidate[],
): Promise<ClassifiedUnanswered> {
  if (candidates.length === 0) {
    return { candidates: 0, needsReplyCount: 0, verdicts: [], tokens: { input: 0, output: 0 } };
  }

  const userPrompt = JSON.stringify(
    candidates.map((c) => ({ requestId: c.requestId, mensagens: c.messages })),
    null,
    2,
  );

  const { data, tokens } = await chatJson<{ results: UnansweredVerdict[] }>({
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    userPrompt,
  });

  const verdicts = Array.isArray(data.results) ? data.results : [];
  const needsReplyCount = verdicts.filter((v) => v.needsReply).length;

  return { candidates: candidates.length, needsReplyCount, verdicts, tokens };
}
