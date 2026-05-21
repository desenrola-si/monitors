import { Check, CheckContext, CheckResult } from '../check.js';

const MIN_FAILURES = 3;
const WINDOW_MINUTES = 60;

/**
 * Detecta tenants com >= 3 mensagens do agente IA falhando no envio
 * (delivery_status_id = 5 / FAILED) na última hora.
 *
 * Não confunde com falha do cliente — só agent (IA). Tenant humano pode
 * ter falhas legítimas (cliente bloqueou número, etc), mas se a IA tá
 * falhando em volume é sinal de problema sistêmico (provider, credencial,
 * janela 24h fechada em muitos contatos, etc).
 */
export class MessageFailuresCheck implements Check {
  readonly code = 'message_delivery_failure';
  readonly alertTypeCode = 'message_delivery_failure' as const;
  readonly description = 'Mensagens do agente IA falhando em volume';

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const rows = await ctx.db.query<{
      tenant_id: string;
      tenant_name: string | null;
      failure_count: string;
      last_failure_at: string;
    }>(
      `
      SELECT
        ml.tenant_id,
        t.name AS tenant_name,
        COUNT(*)::text AS failure_count,
        TO_CHAR(MAX(ml.receivad_at) AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS last_failure_at
      FROM message_logs ml
      LEFT JOIN tenants t ON t.id::text = ml.tenant_id
      WHERE ml.origin = 'agent'
        AND ml.delivery_status_id = 5  -- FAILED
        AND ml.receivad_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
      GROUP BY ml.tenant_id, t.name
      HAVING COUNT(*) >= ${MIN_FAILURES}
      ORDER BY COUNT(*) DESC
      `,
      [],
      'desenrola',
    );

    return rows.map<CheckResult>((r) => {
      const count = Number(r.failure_count);
      const severity = count >= 10 ? 'critical' : 'warning';
      const label = r.tenant_name ?? r.tenant_id;
      return {
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        severity,
        metricValue: count,
        payload: {
          failure_count: count,
          window_minutes: WINDOW_MINUTES,
          last_failure_brt: r.last_failure_at,
        },
        notificationText:
          `${severity === 'critical' ? '🔴' : '🟡'} *${label}* — ` +
          `${count} mensagens do agente FALHARAM no envio na última hora ` +
          `(última às ${r.last_failure_at} BRT).`,
      };
    });
  }
}
