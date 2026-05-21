import { Check, CheckContext, CheckResult } from '../check.js';

const MIN_OCCURRENCES = 2;
const WINDOW_HOURS = 4;

/**
 * Detecta tenants tentando mandar mensagem WhatsApp fora da janela de 24h
 * aberta pelo cliente. Detecção via error_payload com código Meta 131047
 * (Re-engagement message) ou texto explícito sobre 24h.
 *
 * Sinal: o atendente humano precisa usar template aprovado pra reabordar,
 * ou esperar o cliente mandar primeiro. Mensagem nunca chega.
 */
export class Wa24hWindowCheck implements Check {
  readonly code = 'wa_24h_window_closed';
  readonly alertTypeCode = 'wa_24h_window_closed' as const;
  readonly description = 'WhatsApp tentando mandar fora da janela de 24h';

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const rows = await ctx.db.query<{
      tenant_id: string;
      tenant_name: string | null;
      occurrences: string;
      last_at: string;
      distinct_recipients: string;
    }>(
      `
      SELECT
        ml.tenant_id,
        t.name AS tenant_name,
        COUNT(*)::text AS occurrences,
        COUNT(DISTINCT ml.request_id)::text AS distinct_recipients,
        TO_CHAR(MAX(ml.receivad_at) AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS last_at
      FROM message_logs ml
      LEFT JOIN tenants t ON t.id::text = ml.tenant_id
      WHERE ml.channel = 'WHATSAPP'
        AND ml.delivery_status_id = 5  -- FAILED
        AND ml.receivad_at >= NOW() - INTERVAL '${WINDOW_HOURS} hours'
        AND (
          ml.error_payload->>'code' = '131047'
          OR ml.error_payload::text ILIKE '%24%hour%'
          OR ml.error_payload::text ILIKE '%24 horas%'
          OR ml.error_payload::text ILIKE '%re-engagement%'
        )
      GROUP BY ml.tenant_id, t.name
      HAVING COUNT(*) >= ${MIN_OCCURRENCES}
      ORDER BY COUNT(*) DESC
      `,
      [],
      'desenrola',
    );

    return rows.map<CheckResult>((r) => {
      const count = Number(r.occurrences);
      const distinct = Number(r.distinct_recipients);
      const severity = distinct >= 3 ? 'critical' : 'warning';
      const label = r.tenant_name ?? r.tenant_id;
      return {
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        severity,
        metricValue: distinct,
        payload: {
          attempts: count,
          distinct_recipients: distinct,
          window_hours: WINDOW_HOURS,
          last_attempt_brt: r.last_at,
        },
        notificationText:
          `${severity === 'critical' ? '🔴' : '🟡'} *${label}* — ` +
          `${distinct} cliente(s) ficaram fora da janela WhatsApp 24h ` +
          `(${count} tentativas nas últimas ${WINDOW_HOURS}h, última às ${r.last_at}). ` +
          `Precisa usar template aprovado pra reabordar.`,
      };
    });
  }
}
