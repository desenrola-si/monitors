import { desenrolaPool, workflowPool } from '../db.js';
import { anonymize } from '../anonymizer.js';

export type ConversationBucket = 'no_conversion' | 'handoff' | 'conversion';

export interface SampledMessage {
  ts: string;
  sender: 'cliente' | 'IA' | 'humano' | 'template' | 'outro';
  text: string;
}

export interface SampledConversation {
  bucket: ConversationBucket;
  sessionId: string;
  startedAtBrt: string;
  channel: string;
  messageCount: number;
  outcome: string;
  messages: SampledMessage[];
}

export interface SampledConversations {
  noConversion: SampledConversation[];
  handoff: SampledConversation[];
  conversion: SampledConversation[];
}

const MESSAGES_PER_SESSION = 50;
const MAX_CHARS_PER_MESSAGE = 300;
const MIN_MESSAGES_FOR_LONG_SESSION = 6;

interface SessionRow {
  id: string;
  request_id: string;
  type: string;
  started_at: string;
  finished_at: string | null;
  msg_count: number;
}

interface WaIdOutcome {
  hasCreate: boolean;
  hasHandoff: boolean;
  createTools: string[];
}

type EnrichedSession = SessionRow & WaIdOutcome;

function utcRangeForBrtDay(reportDate: string): { start: string; end: string } {
  return {
    start: `'${reportDate} 03:00:00'`,
    end: `('${reportDate}'::date + INTERVAL '1 day' + INTERVAL '3 hours')::timestamp`,
  };
}

/**
 * Lista todas as sessions iniciadas no dia BRT, com contagem de mensagens.
 *
 * As flags de outcome (has_create / has_handoff) NÃO vêm daqui — elas vivem
 * em `workflow_processor.execution_step_logs.metadata.tool_calls` e são
 * resolvidas em separado por `loadOutcomesByWaId`, agregadas por wa_id
 * (= request_id), e então joinadas em memória com cada session.
 */
async function listSessionsWithMsgCount(
  tenantId: string,
  reportDate: string,
): Promise<SessionRow[]> {
  const r = utcRangeForBrtDay(reportDate);

  const { rows } = await desenrolaPool.query<SessionRow>(
    `
      WITH sess AS (
        SELECT
          s.id,
          s.request_id,
          s.type,
          s.started_at,
          s.finished_at
        FROM service_sessions s
        WHERE s.tenant_id = $1
          AND s.started_at >= ${r.start}
          AND s.started_at <  ${r.end}
      ),
      msg_counts AS (
        SELECT service_session_id, COUNT(*)::int AS msg_count
        FROM message_logs
        WHERE tenant_id = $1
          AND service_session_id IN (SELECT id FROM sess)
        GROUP BY service_session_id
      )
      SELECT
        se.id,
        se.request_id,
        se.type,
        se.started_at::text                                AS started_at,
        se.finished_at::text                               AS finished_at,
        COALESCE(mc.msg_count, 0)                          AS msg_count
      FROM sess se
      LEFT JOIN msg_counts mc ON mc.service_session_id = se.id
    `,
    [tenantId],
  );

  return rows;
}

async function loadOutcomesByWaId(
  tenantId: string,
  reportDate: string,
): Promise<Map<string, WaIdOutcome>> {
  const { rows } = await workflowPool.query<{
    wa_id: string | null;
    has_create: boolean;
    has_handoff: boolean;
    create_tools: string[] | null;
  }>(
    `
      WITH ex AS (
        SELECT
          we.id,
          COALESCE(
            we.input #>> '{rawPayload,entry,0,changes,0,value,contacts,0,wa_id}',
            we.input #>> '{rawPayload,entry,0,messaging,0,sender,id}'
          ) AS wa_id
        FROM workflow_executions we
        WHERE we.tenant_id = $1
          AND we.started_at >= ('${reportDate} 03:00:00'::timestamptz)
          AND we.started_at <  (('${reportDate}'::date + INTERVAL '1 day' + INTERVAL '3 hours')::timestamptz)
      ),
      tool_calls AS (
        SELECT
          ex.wa_id,
          tc->>'tool' AS tool_name,
          tc->'result'->>'success' AS success_str,
          tc->'result' ? 'data' AS has_data
        FROM ex
        JOIN execution_step_logs esl ON esl.workflow_execution_id = ex.id
        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(esl.metadata->'tool_calls','[]'::jsonb)
        ) AS tc
        WHERE esl.step_type = 'ai_processing'
          AND ex.wa_id IS NOT NULL
      )
      SELECT
        wa_id,
        BOOL_OR(
          tool_name LIKE 'create_%'
          AND (success_str = 'true' OR has_data)
        ) AS has_create,
        BOOL_OR(tool_name = 'request_human_intervention') AS has_handoff,
        ARRAY_REMOVE(
          ARRAY_AGG(DISTINCT CASE
            WHEN tool_name LIKE 'create_%'
             AND (success_str = 'true' OR has_data)
            THEN tool_name
          END),
          NULL
        ) AS create_tools
      FROM tool_calls
      GROUP BY wa_id
    `,
    [tenantId],
  );

  const out = new Map<string, WaIdOutcome>();
  for (const r of rows) {
    if (!r.wa_id) continue;
    out.set(r.wa_id, {
      hasCreate: r.has_create,
      hasHandoff: r.has_handoff,
      createTools: r.create_tools ?? [],
    });
  }
  return out;
}

async function loadSessionMessages(
  tenantId: string,
  sessionId: string,
  customerNames: string[],
): Promise<SampledMessage[]> {
  const { rows } = await desenrolaPool.query<{
    ts_brt: string;
    origin: string;
    message: string | null;
    attachments: unknown;
  }>(
    `
      SELECT
        TO_CHAR(
          (receivad_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo',
          'HH24:MI:SS'
        )                                          AS ts_brt,
        COALESCE(origin, 'outro')                  AS origin,
        message,
        attachments
      FROM message_logs
      WHERE tenant_id = $1
        AND service_session_id = $2
      ORDER BY receivad_at DESC
      LIMIT $3
    `,
    [tenantId, sessionId, MESSAGES_PER_SESSION],
  );

  const ordered = rows.slice().reverse();

  return ordered.map((r) => {
    const sender = mapSender(r.origin);
    const rawText = (r.message ?? '').trim();
    const attText = describeAttachments(r.attachments);
    const combined = [rawText, attText].filter(Boolean).join(' ');
    const truncated =
      combined.length > MAX_CHARS_PER_MESSAGE
        ? combined.slice(0, MAX_CHARS_PER_MESSAGE) + '…'
        : combined;

    return {
      ts: r.ts_brt,
      sender,
      text: anonymize(truncated, { customerNames }),
    };
  });
}

function mapSender(origin: string): SampledMessage['sender'] {
  switch (origin) {
    case 'user':
      return 'cliente';
    case 'agent':
      return 'IA';
    case 'tenant':
      return 'humano';
    case 'template':
      return 'template';
    default:
      return 'outro';
  }
}

function describeAttachments(attachments: unknown): string {
  if (!attachments) return '';
  if (!Array.isArray(attachments)) return '';
  const kinds = attachments
    .map((a) =>
      typeof a === 'object' && a && 'kind' in a
        ? (a as { kind: string }).kind
        : null,
    )
    .filter(Boolean) as string[];
  if (kinds.length === 0) return '';
  return `[anexo: ${kinds.join(', ')}]`;
}

async function listCustomerNames(tenantId: string): Promise<string[]> {
  const { rows } = await desenrolaPool.query<{ name: string }>(
    `
      SELECT DISTINCT name
      FROM customers
      WHERE tenant_id = $1
        AND name IS NOT NULL
        AND length(name) >= 3
    `,
    [tenantId],
  );
  return rows.map((r) => r.name);
}

function sessionOutcome(row: EnrichedSession): string {
  if (row.hasCreate) {
    const friendly = row.createTools.map(friendlyCreateTool);
    const unique = [...new Set(friendly)];
    return unique.length === 0
      ? 'fechou agendamento com sucesso'
      : unique.join(' + ');
  }
  if (row.hasHandoff) {
    return 'transferido pra atendimento humano';
  }
  return 'sessão longa sem agendamento nem handoff';
}

function friendlyCreateTool(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (lower.includes('reinspect') || lower.includes('reinspec')) {
    return 'agendou reinspeção';
  }
  if (lower.includes('work_order') || lower.includes('inspection')) {
    return 'agendou inspeção';
  }
  if (lower.includes('reschedule')) {
    return 'reagendou';
  }
  return 'fechou agendamento';
}

export async function sampleConversations(
  tenantId: string,
  reportDate: string,
  N: number,
): Promise<SampledConversations> {
  if (N <= 0) {
    return { noConversion: [], handoff: [], conversion: [] };
  }

  const [sessions, customerNames, outcomesByWaId] = await Promise.all([
    listSessionsWithMsgCount(tenantId, reportDate),
    listCustomerNames(tenantId),
    loadOutcomesByWaId(tenantId, reportDate),
  ]);

  const enriched: EnrichedSession[] = sessions.map((s) => {
    const o = outcomesByWaId.get(s.request_id);
    return {
      ...s,
      hasCreate: o?.hasCreate ?? false,
      hasHandoff: o?.hasHandoff ?? false,
      createTools: o?.createTools ?? [],
    };
  });

  const conversionSessions = enriched.filter((s) => s.hasCreate);
  const handoffSessions = enriched.filter((s) => !s.hasCreate && s.hasHandoff);
  const noConvSessions = enriched.filter(
    (s) =>
      !s.hasCreate &&
      !s.hasHandoff &&
      s.msg_count >= MIN_MESSAGES_FOR_LONG_SESSION,
  );

  conversionSessions.sort((a, b) => b.msg_count - a.msg_count);
  handoffSessions.sort((a, b) => b.msg_count - a.msg_count);
  noConvSessions.sort((a, b) => b.msg_count - a.msg_count);

  const pickTop = (arr: EnrichedSession[]) => arr.slice(0, N);

  const [noConvMsgs, handoffMsgs, convMsgs] = await Promise.all([
    Promise.all(
      pickTop(noConvSessions).map((s) =>
        toSampled(s, 'no_conversion', tenantId, customerNames),
      ),
    ),
    Promise.all(
      pickTop(handoffSessions).map((s) =>
        toSampled(s, 'handoff', tenantId, customerNames),
      ),
    ),
    Promise.all(
      pickTop(conversionSessions).map((s) =>
        toSampled(s, 'conversion', tenantId, customerNames),
      ),
    ),
  ]);

  return {
    noConversion: noConvMsgs,
    handoff: handoffMsgs,
    conversion: convMsgs,
  };
}

async function toSampled(
  row: EnrichedSession,
  bucket: ConversationBucket,
  tenantId: string,
  customerNames: string[],
): Promise<SampledConversation> {
  const messages = await loadSessionMessages(tenantId, row.id, customerNames);
  const startedAtBrt = toBrtIso(row.started_at);

  return {
    bucket,
    sessionId: row.id,
    startedAtBrt,
    channel: row.type ?? 'unknown',
    messageCount: row.msg_count,
    outcome: sessionOutcome(row),
    messages,
  };
}

function toBrtIso(utcText: string): string {
  const d = new Date(utcText.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return utcText;
  const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().replace('Z', '-03:00');
}
