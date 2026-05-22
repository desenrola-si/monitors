import { Check, CheckContext, CheckResult } from '../check.js';

const MIN_OCCURRENCES = 1;
const STUCK_MINUTES = 15;
const WINDOW_HOURS = 4;

/**
 * Detecta mensagens Instagram DM enviadas pelo agente que ficaram presas em
 * status PENDING_CONFIRMATION (id=1) por mais de 15min — provider deveria
 * confirmar SENT/DELIVERED em segundos. Limbo persistente = mensagem
 * silenciosamente nunca chegou (incidente Hilary/Monobox + Elisabete/Rei do
 * Lanche, mai/2026).
 */
export class IgDmSilentDropCheck implements Check {
  readonly code = 'ig_dm_silent_drop';
  readonly alertTypeCode = 'ig_dm_silent_drop' as const;
  readonly description = 'Instagram DM presa sem confirmação do provider';

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const rows = await ctx.db.query<{
      tenant_id: string;
      tenant_name: string | null;
      stuck_count: string;
      last_attempt_at: string;
    }>(
      `
      SELECT
        ml.tenant_id,
        t.name AS tenant_name,
        COUNT(*)::text AS stuck_count,
        TO_CHAR((MAX(ml.receivad_at) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS last_attempt_at
      FROM message_logs ml
      LEFT JOIN tenants t ON t.id::text = ml.tenant_id
      WHERE ml.channel = 'INSTAGRAM'
        AND ml.origin = 'agent'
        AND ml.delivery_status_id = 1  -- PENDING_CONFIRMATION
        AND ml.receivad_at >= NOW() - INTERVAL '${WINDOW_HOURS} hours'
        AND ml.receivad_at < NOW() - INTERVAL '${STUCK_MINUTES} minutes'
      GROUP BY ml.tenant_id, t.name
      HAVING COUNT(*) >= ${MIN_OCCURRENCES}
      ORDER BY COUNT(*) DESC
      `,
      [],
      'desenrola',
    );

    return rows.map<CheckResult>((r) => {
      const count = Number(r.stuck_count);
      const severity = count >= 3 ? 'critical' : 'warning';
      const label = r.tenant_name ?? r.tenant_id;
      return {
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        severity,
        metricValue: count,
        payload: {
          stuck_count: count,
          stuck_threshold_minutes: STUCK_MINUTES,
          window_hours: WINDOW_HOURS,
          last_attempt_brt: r.last_attempt_at,
        },
        notificationText:
          `${severity === 'critical' ? '🔴' : '🟡'} *${label}* — ` +
          `${count} mensagem(ns) do Instagram DM presa(s) há mais de ${STUCK_MINUTES}min ` +
          `sem confirmação do provider (última tentativa: ${r.last_attempt_at} BRT). ` +
          `Provavelmente cliente não recebeu — checar logs de envio.`,
      };
    });
  }
}
