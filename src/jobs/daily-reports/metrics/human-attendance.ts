import { desenrolaPool } from '../db.js';
import { HumanAttendanceMetrics } from './types.js';

/**
 * Janela do dia em BRT (UTC-3): início 03:00 UTC do reportDate até 03:00 UTC
 * do dia seguinte. Mantém consistência com desenrola.ts/workflow.ts.
 */
function utcRangeForBrtDay(reportDate: string): { start: string; end: string } {
  return {
    start: `'${reportDate} 03:00:00'`,
    end: `('${reportDate}'::date + INTERVAL '1 day' + INTERVAL '3 hours')::timestamp`,
  };
}

const TO_BRT = (col: string): string =>
  `(${col} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'`;

/**
 * Coleta métricas pro pipeline de relatório de ATENDIMENTO HUMANO (tenants
 * sem IA configurada). Foco em:
 *
 *  - Volume de mensagens entre cliente (origin='user') e equipe (origin='tenant')
 *  - Tempo de primeira resposta da equipe na sessão (mediana, p95, faixas)
 *  - Clientes que ficaram sem resposta alguma no dia
 *  - Distribuição por atendente (service_sessions.assigned_user_id → users.name)
 *  - Hora de pico
 *
 * `origin='agent'` (IA) é ignorado de propósito — esses tenants não têm IA
 * conduzindo, mas a coluna pode existir esporadicamente de mensagens de
 * sistema, então não filtra antecipado: só não conta como "equipe".
 */
export async function collectHumanAttendanceMetrics(
  tenantId: string,
  reportDate: string,
): Promise<HumanAttendanceMetrics> {
  const r = utcRangeForBrtDay(reportDate);

  // Volume básico de mensagens, customers e sessões
  const { rows: volumeRows } = await desenrolaPool.query<{
    user_msgs: string;
    tenant_msgs: string;
    template_msgs: string;
    total: string;
    unique_customers: string;
    unique_sessions: string;
    first_brt: string | null;
    last_brt: string | null;
  }>(
    `
      SELECT
        SUM(CASE WHEN origin = 'user'     THEN 1 ELSE 0 END)::text      AS user_msgs,
        SUM(CASE WHEN origin = 'tenant'   THEN 1 ELSE 0 END)::text      AS tenant_msgs,
        SUM(CASE WHEN origin = 'template' THEN 1 ELSE 0 END)::text      AS template_msgs,
        COUNT(*)::text                                                  AS total,
        COUNT(DISTINCT request_id)::text                                AS unique_customers,
        COUNT(DISTINCT service_session_id)
          FILTER (WHERE service_session_id IS NOT NULL)::text           AS unique_sessions,
        TO_CHAR(${TO_BRT('MIN(receivad_at)')}, 'YYYY-MM-DD"T"HH24:MI:SS') AS first_brt,
        TO_CHAR(${TO_BRT('MAX(receivad_at)')}, 'YYYY-MM-DD"T"HH24:MI:SS') AS last_brt
      FROM message_logs
      WHERE tenant_id = $1
        AND receivad_at >= ${r.start}
        AND receivad_at <  ${r.end}
    `,
    [tenantId],
  );
  const vol = volumeRows[0];

  // Hora de pico (de qualquer mensagem)
  const { rows: peakRows } = await desenrolaPool.query<{
    hour_brt: number;
    count: number;
  }>(
    `
      SELECT
        EXTRACT(HOUR FROM ${TO_BRT('receivad_at')})::int AS hour_brt,
        COUNT(*)::int                                    AS count
      FROM message_logs
      WHERE tenant_id = $1
        AND receivad_at >= ${r.start}
        AND receivad_at <  ${r.end}
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 1
    `,
    [tenantId],
  );

  // Tempo de primeira resposta da equipe: por sessão, MIN(receivad_at) user →
  // MIN(receivad_at) tenant > primeiro user. Sessões sem tenant reply = unanswered.
  const { rows: responseRows } = await desenrolaPool.query<{
    sessions_with_user_msg: string;
    sessions_with_team_reply: string;
    unanswered_sessions: string;
    median_min: string | null;
    p95_min: string | null;
    under_5min: string;
    under_30min: string;
  }>(
    `
      WITH session_first_user AS (
        SELECT service_session_id, MIN(receivad_at) AS first_user_at
        FROM message_logs
        WHERE tenant_id = $1
          AND origin = 'user'
          AND service_session_id IS NOT NULL
          AND receivad_at >= ${r.start}
          AND receivad_at <  ${r.end}
        GROUP BY service_session_id
      ),
      session_first_team_reply AS (
        SELECT
          su.service_session_id,
          su.first_user_at,
          (
            SELECT MIN(ml.receivad_at)
            FROM message_logs ml
            WHERE ml.tenant_id = $1
              AND ml.origin = 'tenant'
              AND ml.service_session_id = su.service_session_id
              AND ml.receivad_at > su.first_user_at
          ) AS first_team_at
        FROM session_first_user su
      ),
      with_delta AS (
        SELECT
          *,
          CASE WHEN first_team_at IS NULL THEN NULL
               ELSE EXTRACT(EPOCH FROM (first_team_at - first_user_at)) / 60.0
          END AS delta_min
        FROM session_first_team_reply
      )
      SELECT
        COUNT(*)::text                                                  AS sessions_with_user_msg,
        COUNT(first_team_at)::text                                      AS sessions_with_team_reply,
        COUNT(*) FILTER (WHERE first_team_at IS NULL)::text             AS unanswered_sessions,
        ROUND(
          percentile_cont(0.5) WITHIN GROUP (ORDER BY delta_min)::numeric,
          1
        )::text                                                         AS median_min,
        ROUND(
          percentile_cont(0.95) WITHIN GROUP (ORDER BY delta_min)::numeric,
          1
        )::text                                                         AS p95_min,
        COUNT(*) FILTER (WHERE delta_min IS NOT NULL AND delta_min <= 5)::text   AS under_5min,
        COUNT(*) FILTER (WHERE delta_min IS NOT NULL AND delta_min <= 30)::text  AS under_30min
      FROM with_delta
    `,
    [tenantId],
  );
  const resp = responseRows[0];

  // Clientes que mandaram msg mas nunca foram respondidos NEM por agent NEM por tenant no dia.
  // Usa request_id (id do cliente no canal) — assim cobre o caso da sessão antiga reaberta.
  const { rows: unansweredCustomers } = await desenrolaPool.query<{
    count: string;
  }>(
    `
      SELECT COUNT(DISTINCT um.request_id)::text AS count
      FROM message_logs um
      WHERE um.tenant_id = $1
        AND um.origin = 'user'
        AND um.receivad_at >= ${r.start}
        AND um.receivad_at <  ${r.end}
        AND NOT EXISTS (
          SELECT 1 FROM message_logs r
          WHERE r.tenant_id = $1
            AND r.request_id = um.request_id
            AND r.origin IN ('tenant', 'agent', 'template')
            AND r.receivad_at >= ${r.start}
            AND r.receivad_at <  ${r.end}
        )
    `,
    [tenantId],
  );

  // Distribuição da equipe: msgs origin='tenant' agrupadas pelo assigned_user_id
  // da sessão. Top 5 atendentes por volume.
  const { rows: teamRows } = await desenrolaPool.query<{
    user_id: string | null;
    user_name: string | null;
    user_email: string | null;
    messages_sent: string;
  }>(
    `
      SELECT
        ss.assigned_user_id                    AS user_id,
        u.name                                 AS user_name,
        u.email                                AS user_email,
        COUNT(*)::text                         AS messages_sent
      FROM message_logs ml
      JOIN service_sessions ss ON ss.id = ml.service_session_id
      LEFT JOIN users u ON u.id = ss.assigned_user_id
      WHERE ml.tenant_id = $1
        AND ml.origin = 'tenant'
        AND ml.receivad_at >= ${r.start}
        AND ml.receivad_at <  ${r.end}
      GROUP BY ss.assigned_user_id, u.name, u.email
      ORDER BY COUNT(*) DESC
      LIMIT 10
    `,
    [tenantId],
  );

  const activeAttendants = teamRows.filter((t) => t.user_id !== null).length;

  return {
    messages: {
      total: Number(vol?.total ?? 0),
      user: Number(vol?.user_msgs ?? 0),
      tenant: Number(vol?.tenant_msgs ?? 0),
      template: Number(vol?.template_msgs ?? 0),
      uniqueCustomers: Number(vol?.unique_customers ?? 0),
      uniqueSessions: Number(vol?.unique_sessions ?? 0),
      firstActivityBrt: vol?.first_brt ?? null,
      lastActivityBrt: vol?.last_brt ?? null,
    },
    peakHour: peakRows[0]
      ? {
          hourBrt: Number(peakRows[0].hour_brt),
          count: Number(peakRows[0].count),
        }
      : null,
    responseTime: {
      sessionsWithUserMsg: Number(resp?.sessions_with_user_msg ?? 0),
      sessionsWithTeamReply: Number(resp?.sessions_with_team_reply ?? 0),
      unansweredSessions: Number(resp?.unanswered_sessions ?? 0),
      medianMinutes: resp?.median_min ? Number(resp.median_min) : null,
      p95Minutes: resp?.p95_min ? Number(resp.p95_min) : null,
      under5min: Number(resp?.under_5min ?? 0),
      under30min: Number(resp?.under_30min ?? 0),
    },
    unanswered: {
      customersWithoutAnyReply: Number(unansweredCustomers[0]?.count ?? 0),
    },
    team: {
      activeAttendants,
      distribution: teamRows.map((t) => ({
        userId: t.user_id,
        name: t.user_name,
        email: t.user_email,
        messagesSent: Number(t.messages_sent),
      })),
    },
  };
}
