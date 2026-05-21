import { desenrolaPool } from '../db.js';
import { DesenrolaMetrics } from './types.js';

/**
 * Janela do dia em BRT (UTC-3): início 03:00 UTC do reportDate até 03:00 UTC
 * do dia seguinte. Usa literais UTC explícitos pra evitar dependência da
 * timezone da sessão do Postgres ao comparar com `timestamp without time
 * zone` (que armazena valores em UTC).
 */
function utcRangeForBrtDay(reportDate: string): { start: string; end: string } {
  return {
    start: `'${reportDate} 03:00:00'`,
    end: `('${reportDate}'::date + INTERVAL '1 day' + INTERVAL '3 hours')::timestamp`,
  };
}

const TO_BRT = (col: string) =>
  `(${col} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'`;

export async function collectDesenrolaMetrics(
  tenantId: string,
  reportDate: string,
): Promise<DesenrolaMetrics> {
  const r = utcRangeForBrtDay(reportDate);

  const { rows: msgRows } = await desenrolaPool.query<{
    total: string;
    unique_customers: string;
    unique_sessions: string;
    user_msgs: string;
    agent_msgs: string;
    tenant_msgs: string;
    template_msgs: string;
    first_brt: string | null;
    last_brt: string | null;
  }>(
    `
      SELECT
        COUNT(*)::text                                                  AS total,
        COUNT(DISTINCT request_id)::text                                AS unique_customers,
        COUNT(DISTINCT service_session_id)
          FILTER (WHERE service_session_id IS NOT NULL)::text           AS unique_sessions,
        SUM(CASE WHEN origin = 'user'     THEN 1 ELSE 0 END)::text      AS user_msgs,
        SUM(CASE WHEN origin = 'agent'    THEN 1 ELSE 0 END)::text      AS agent_msgs,
        SUM(CASE WHEN origin = 'tenant'   THEN 1 ELSE 0 END)::text      AS tenant_msgs,
        SUM(CASE WHEN origin = 'template' THEN 1 ELSE 0 END)::text      AS template_msgs,
        TO_CHAR(${TO_BRT('MIN(receivad_at)')}, 'YYYY-MM-DD"T"HH24:MI:SS') AS first_brt,
        TO_CHAR(${TO_BRT('MAX(receivad_at)')}, 'YYYY-MM-DD"T"HH24:MI:SS') AS last_brt
      FROM message_logs
      WHERE tenant_id = $1
        AND receivad_at >= ${r.start}
        AND receivad_at <  ${r.end}
    `,
    [tenantId],
  );

  const msg = msgRows[0];

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

  const { rows: sessionRows } = await desenrolaPool.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM service_sessions
      WHERE tenant_id = $1
        AND started_at >= ${r.start}
        AND started_at <  ${r.end}
    `,
    [tenantId],
  );

  const { rows: handoffRows } = await desenrolaPool.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM customers
      WHERE tenant_id = $1
        AND (is_human = true OR needs_human_interaction = true)
        AND GREATEST(is_human_at, updated_at) >= ${r.start}
        AND GREATEST(is_human_at, updated_at) <  ${r.end}
    `,
    [tenantId],
  );

  return {
    messages: {
      total: Number(msg?.total ?? 0),
      byOrigin: {
        user: Number(msg?.user_msgs ?? 0),
        agent: Number(msg?.agent_msgs ?? 0),
        tenant: Number(msg?.tenant_msgs ?? 0),
        template: Number(msg?.template_msgs ?? 0),
      },
      uniqueCustomers: Number(msg?.unique_customers ?? 0),
      uniqueSessions: Number(msg?.unique_sessions ?? 0),
      firstActivityBrt: msg?.first_brt ?? null,
      lastActivityBrt: msg?.last_brt ?? null,
      peakHour: peakRows[0]
        ? {
            hourBrt: Number(peakRows[0].hour_brt),
            count: Number(peakRows[0].count),
          }
        : null,
    },
    sessions: {
      started: Number(sessionRows[0]?.count ?? 0),
    },
    humanHandoff: {
      customersHandedOff: Number(handoffRows[0]?.count ?? 0),
    },
  };
}
