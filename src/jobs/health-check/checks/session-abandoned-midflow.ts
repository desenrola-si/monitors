import { Check, CheckContext, CheckResult } from '../check.js';

const NO_REPLY_HOURS = 4;
const MIN_OCCURRENCES = 2;

/**
 * Detecta service_sessions abertas onde a última mensagem foi do cliente
 * há mais de 4h sem resposta (nem IA, nem humano). Cliente abandonou ou
 * está esperando — operacionalmente um lead esquecido.
 */
export class SessionAbandonedMidflowCheck implements Check {
  readonly code = 'session_abandoned_midflow';
  readonly alertTypeCode = 'session_abandoned_midflow' as const;
  readonly description = 'Atendimento aberto sem resposta há horas';

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const rows = await ctx.db.query<{
      tenant_id: string;
      tenant_name: string | null;
      abandoned_count: string;
      oldest_last_user_msg_at: string;
    }>(
      `
      WITH session_last_msg AS (
        SELECT DISTINCT ON (ml.service_session_id)
          ml.service_session_id,
          ml.tenant_id,
          ml.origin AS last_origin,
          ml.receivad_at AS last_msg_at
        FROM message_logs ml
        WHERE ml.service_session_id IS NOT NULL
          AND ml.receivad_at >= NOW() - INTERVAL '7 days'
        ORDER BY ml.service_session_id, ml.receivad_at DESC
      ),
      abandoned AS (
        SELECT
          slm.tenant_id,
          slm.service_session_id,
          slm.last_msg_at
        FROM session_last_msg slm
        JOIN service_sessions ss ON ss.id = slm.service_session_id
        WHERE ss.finished_at IS NULL
          AND slm.last_origin = 'user'
          AND slm.last_msg_at < NOW() - INTERVAL '${NO_REPLY_HOURS} hours'
          AND slm.last_msg_at >= NOW() - INTERVAL '7 days'
      )
      SELECT
        a.tenant_id,
        t.name AS tenant_name,
        COUNT(*)::text AS abandoned_count,
        TO_CHAR(MIN(a.last_msg_at) AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS oldest_last_user_msg_at
      FROM abandoned a
      LEFT JOIN tenants t ON t.id::text = a.tenant_id
      GROUP BY a.tenant_id, t.name
      HAVING COUNT(*) >= ${MIN_OCCURRENCES}
      ORDER BY COUNT(*) DESC
      `,
      [],
      'desenrola',
    );

    return rows.map<CheckResult>((r) => {
      const count = Number(r.abandoned_count);
      const severity = count >= 10 ? 'critical' : 'warning';
      const label = r.tenant_name ?? r.tenant_id;
      return {
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        severity,
        metricValue: count,
        payload: {
          abandoned_count: count,
          no_reply_hours: NO_REPLY_HOURS,
          oldest_user_msg_brt: r.oldest_last_user_msg_at,
        },
        notificationText:
          `${severity === 'critical' ? '🔴' : '🟡'} *${label}* — ` +
          `${count} cliente(s) esperando resposta há mais de ${NO_REPLY_HOURS}h ` +
          `(mais antigo desde ${r.oldest_last_user_msg_at} BRT). ` +
          `Verificar se vale retomar a conversa.`,
      };
    });
  }
}
