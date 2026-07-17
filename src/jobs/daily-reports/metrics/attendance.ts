import { desenrolaPool } from '../db.js';
import { utcRangeForBrtDay } from './human-attendance.js';
import { AttendanceMetrics } from './types.js';

/**
 * Métricas do ATENDIMENTO HUMANO no fluxo de IA (modo 'ai'), pra dar ao cliente
 * o "quadro do atendimento total" — não só o desempenho da IA. Duas leituras:
 *
 *  1. handoffToHuman — quanto o cliente esperou desde que a IA passou pra equipe
 *     (evento `ai_ended`/`opened_for_human` no histórico da sessão) até um humano
 *     DE FATO atender (1ª mensagem origin='tenant' na sessão, após o handoff).
 *     É a espera real: fila + tempo até o atendente responder.
 *
 *  2. closure + adoption — o ATENDIMENTO tem um ciclo: inicia e ENCERRA. Quem
 *     encerra diz se a equipe opera a ferramenta de Atendimento corretamente:
 *       - encerrado por HUMANO   → `closed` com performed_by_user_id (a equipe
 *                                   finalizou/fechou pelo painel).
 *       - encerrado pela IA      → `closed` com metadata.auto=true (cron fechou
 *                                   por inatividade porque ficou parado).
 *     Se a equipe assume atendimentos mas quase nunca ENCERRA (a IA encerra
 *     sozinha), ela não está fechando o ciclo — vira ressalva + convite pra usar
 *     a ferramenta corretamente no relatório.
 *
 * `assigned` NÃO serve pra distinguir "usa o painel de Atendimento" de "responde
 * só pelo Conversas": responder pelo Conversas também gera `assigned` (auto-claim
 * na 1ª resposta). Fechar o atendimento, sim, é ação deliberada de gestão.
 */
export async function collectAttendanceMetrics(
  tenantId: string,
  reportDate: string,
): Promise<AttendanceMetrics> {
  const r = utcRangeForBrtDay(reportDate);

  // 1. Handoff (IA → humano) → 1ª resposta humana na mesma sessão.
  const { rows: handoffRows } = await desenrolaPool.query<{
    handoffs: string;
    answered_by_human: string;
    unanswered: string;
    median_min: string | null;
    p95_min: string | null;
    under_5min: string;
    under_30min: string;
  }>(
    `
      WITH handoff AS (
        SELECT service_session_id, MIN(created_at) AS handoff_at
        FROM service_session_events
        WHERE tenant_id = $1
          AND action IN ('ai_ended', 'opened_for_human')
          AND created_at >= ${r.start}
          AND created_at <  ${r.end}
        GROUP BY service_session_id
      ),
      paired AS (
        SELECT
          h.service_session_id,
          h.handoff_at,
          (
            SELECT MIN(ml.receivad_at)
            FROM message_logs ml
            WHERE ml.tenant_id = $1
              AND ml.origin = 'tenant'
              AND ml.service_session_id = h.service_session_id
              AND ml.receivad_at > h.handoff_at
          ) AS human_at
        FROM handoff h
      ),
      with_delta AS (
        SELECT
          *,
          CASE WHEN human_at IS NULL THEN NULL
               ELSE EXTRACT(EPOCH FROM (human_at - handoff_at)) / 60.0
          END AS delta_min
        FROM paired
      )
      SELECT
        COUNT(*)::text                                                   AS handoffs,
        COUNT(human_at)::text                                            AS answered_by_human,
        COUNT(*) FILTER (WHERE human_at IS NULL)::text                   AS unanswered,
        ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY delta_min)::numeric, 1)::text  AS median_min,
        ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY delta_min)::numeric, 1)::text AS p95_min,
        COUNT(*) FILTER (WHERE delta_min IS NOT NULL AND delta_min <= 5)::text  AS under_5min,
        COUNT(*) FILTER (WHERE delta_min IS NOT NULL AND delta_min <= 30)::text AS under_30min
      FROM with_delta
    `,
    [tenantId],
  );
  const h = handoffRows[0];

  // 2. Ciclo de encerramento: quem fecha os atendimentos.
  //    - por humano   = performed_by_user_id preenchido
  //    - pela IA      = metadata.auto = true (cron de inatividade)
  //    - sistema/outro = fechado sem ator identificável e sem flag auto
  const { rows: closureRows } = await desenrolaPool.query<{
    sessions_assumed: string;
    closed_by_human: string;
    closed_by_ai: string;
    closed_other: string;
  }>(
    `
      SELECT
        COUNT(DISTINCT service_session_id)
          FILTER (WHERE action = 'assigned')::text                             AS sessions_assumed,
        COUNT(*) FILTER (
          WHERE action = 'closed' AND performed_by_user_id IS NOT NULL
        )::text                                                                AS closed_by_human,
        COUNT(*) FILTER (
          WHERE action = 'closed' AND (metadata->>'auto') = 'true'
        )::text                                                                AS closed_by_ai,
        COUNT(*) FILTER (
          WHERE action = 'closed'
            AND performed_by_user_id IS NULL
            AND (metadata->>'auto') IS DISTINCT FROM 'true'
        )::text                                                                AS closed_other
      FROM service_session_events
      WHERE tenant_id = $1
        AND created_at >= ${r.start}
        AND created_at <  ${r.end}
    `,
    [tenantId],
  );
  const c = closureRows[0];

  // 3. Volume de resposta humana no dia (origin='tenant') — atividade da equipe.
  const { rows: humanRows } = await desenrolaPool.query<{ tenant_msgs: string }>(
    `
      SELECT COUNT(*)::text AS tenant_msgs
      FROM message_logs
      WHERE tenant_id = $1
        AND origin = 'tenant'
        AND receivad_at >= ${r.start}
        AND receivad_at <  ${r.end}
    `,
    [tenantId],
  );

  const sessionsAssumedByHuman = Number(c?.sessions_assumed ?? 0);
  const closedByHuman = Number(c?.closed_by_human ?? 0);
  const closedByAiInactivity = Number(c?.closed_by_ai ?? 0);
  const closedBySystemOther = Number(c?.closed_other ?? 0);
  const humanReplyMessages = Number(humanRows[0]?.tenant_msgs ?? 0);

  const closedByHumanRate =
    sessionsAssumedByHuman > 0
      ? Number((closedByHuman / sessionsAssumedByHuman).toFixed(2))
      : null;

  // 4. Repasse automático da IA pra fila (reopen_ai_unanswered): threshold
  //    configurado (menor entre as contas habilitadas) + reaberturas no dia.
  //    Dados crus — a leitura "está curto demais?" fica pro relatório.
  const { rows: queueRows } = await desenrolaPool.query<{
    threshold_minutes: string | null;
    reopens_today: string;
    sessions_reopened_today: string;
  }>(
    `
      SELECT
        (
          SELECT MIN(s.time_value * tu.multiplier_minutes)
          FROM reopen_ai_unanswered_settings s
          JOIN time_units tu ON tu.id = s.time_unit_id
          WHERE s.tenant_id = $1 AND s.enabled = true
        )                                                              AS threshold_minutes,
        COUNT(*)::text                                                 AS reopens_today,
        COUNT(DISTINCT service_session_id)::text                       AS sessions_reopened_today
      FROM reopen_ai_unanswered_logs
      WHERE tenant_id = $1
        AND reopened_at >= ${r.start}
        AND reopened_at <  ${r.end}
    `,
    [tenantId],
  );
  const q = queueRows[0];
  const thresholdMinutes =
    q?.threshold_minutes != null ? Number(q.threshold_minutes) : null;
  const aiQueueHandoff =
    thresholdMinutes != null
      ? {
          thresholdMinutes,
          reopensToday: Number(q?.reopens_today ?? 0),
          sessionsReopenedToday: Number(q?.sessions_reopened_today ?? 0),
        }
      : null;

  return {
    handoffToHuman: {
      handoffs: Number(h?.handoffs ?? 0),
      answeredByHuman: Number(h?.answered_by_human ?? 0),
      unanswered: Number(h?.unanswered ?? 0),
      medianMinutes: h?.median_min ? Number(h.median_min) : null,
      p95Minutes: h?.p95_min ? Number(h.p95_min) : null,
      under5min: Number(h?.under_5min ?? 0),
      under30min: Number(h?.under_30min ?? 0),
    },
    closure: {
      sessionsAssumedByHuman,
      closedByHuman,
      closedByAiInactivity,
      closedBySystemOther,
      humanReplyMessages,
      closedByHumanRate,
    },
    adoption: classifyAdoption({
      sessionsAssumedByHuman,
      humanReplyMessages,
      closedByHuman,
      closedByHumanRate,
    }),
    aiQueueHandoff,
  };
}

/**
 * Quanto a equipe fecha o CICLO do atendimento (assume e encerra) pela ferramenta:
 *  - 'inactive'  — sem atividade humana no dia (100% IA). Nada a mostrar/convidar.
 *  - 'not_used'  — a equipe atendeu (assumiu ou respondeu) mas NUNCA encerrou um
 *                  atendimento — os atendimentos ficam abertos até a IA fechar
 *                  sozinha por inatividade. Não fecha o ciclo pela ferramenta.
 *  - 'partial'   — encerra alguns, mas a maior parte fica sem encerramento humano.
 *  - 'full'      — encerra a maior parte dos atendimentos que assume.
 */
function classifyAdoption(x: {
  sessionsAssumedByHuman: number;
  humanReplyMessages: number;
  closedByHuman: number;
  closedByHumanRate: number | null;
}): AttendanceMetrics['adoption'] {
  const humanActive = x.sessionsAssumedByHuman > 0 || x.humanReplyMessages > 0;
  if (!humanActive) return 'inactive';

  if (x.closedByHuman === 0) return 'not_used';

  if (x.closedByHumanRate !== null && x.closedByHumanRate < 0.5) {
    return 'partial';
  }
  return 'full';
}
