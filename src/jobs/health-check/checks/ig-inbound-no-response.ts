import { Check, CheckContext, CheckResult } from '../check.js';

const MIN_OCCURRENCES = 1;
const FLOOR_MINUTES = 5; // dá tempo do debounce (15s) + workflow (até alguns min)
const CEILING_HOURS = 1; // janela curta — > 1h vira session_abandoned_midflow

/**
 * Detecta Instagram DM inbound (cliente mandou mensagem) sem QUALQUER
 * resposta da operação (agent/tenant/template) nos N minutos seguintes,
 * em tenants com IA configurada.
 *
 * Diferente do session_abandoned_midflow (4h+, atendimento humano lento),
 * esse pega o caso CRÍTICO em < 1h — significa que o pipeline da IA
 * descartou silenciosamente (debounce drop, MISSING CALLBACK, subscription
 * bloqueada sem feedback, workflow processor falhou, etc — ver
 * docs/DEBOUNCE_SETTIMEOUT_TECH_DEBT.md no backend).
 *
 * Janela [5min, 1h] permite ação rápida: alerta o time pra resposta manual
 * antes do cliente perder o interesse.
 */
export class IgInboundNoResponseCheck implements Check {
  readonly code = 'ig_inbound_no_response';
  readonly alertTypeCode = 'ig_inbound_no_response' as const;
  readonly description =
    'Cliente Instagram DM sem resposta enquanto IA deveria estar ativa';

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const rows = await ctx.db.query<{
      tenant_id: string;
      tenant_name: string | null;
      count: string;
      oldest_brt: string;
    }>(
      `
      WITH last_user_msg AS (
        SELECT DISTINCT ON (ml.service_session_id)
          ml.service_session_id,
          ml.tenant_id,
          ml.receivad_at AS user_at,
          ml.request_id
        FROM message_logs ml
        WHERE ml.channel = 'INSTAGRAM'
          AND ml.origin = 'user'
          AND ml.service_session_id IS NOT NULL
          AND ml.receivad_at >= NOW() - INTERVAL '${CEILING_HOURS} hours'
          AND ml.receivad_at <  NOW() - INTERVAL '${FLOOR_MINUTES} minutes'
        ORDER BY ml.service_session_id, ml.receivad_at DESC
      ),
      unanswered AS (
        SELECT lum.*
        FROM last_user_msg lum
        WHERE NOT EXISTS (
          SELECT 1 FROM message_logs r
          WHERE r.tenant_id = lum.tenant_id
            AND r.service_session_id = lum.service_session_id
            AND r.origin IN ('agent', 'tenant', 'template')
            AND r.receivad_at > lum.user_at
        )
      ),
      ai_tenants AS (
        SELECT DISTINCT ia.tenant_id::text AS tenant_id
        FROM instagram_account_features iaf
        JOIN instagram_accounts ia ON ia.id = iaf.instagram_account_id
        WHERE iaf.is_active = true
          AND iaf.is_workflow_slug_enabled = true
          AND iaf.workflow_slug IS NOT NULL
          AND iaf.workflow_slug NOT ILIKE 'TODO%'
          AND ia.is_active = true
      )
      SELECT
        u.tenant_id::text AS tenant_id,
        t.name AS tenant_name,
        COUNT(*)::text AS count,
        TO_CHAR((MIN(u.user_at) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS oldest_brt
      FROM unanswered u
      LEFT JOIN tenants t ON t.id::text = u.tenant_id::text
      INNER JOIN ai_tenants ON ai_tenants.tenant_id = u.tenant_id::text
      GROUP BY u.tenant_id, t.name
      HAVING COUNT(*) >= ${MIN_OCCURRENCES}
      ORDER BY COUNT(*) DESC
      `,
      [],
      'desenrola',
    );

    return rows.map<CheckResult>((r) => {
      const count = Number(r.count);
      const severity = count >= 3 ? 'critical' : 'warning';
      const label = r.tenant_name ?? r.tenant_id;
      return {
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        severity,
        metricValue: count,
        payload: {
          unanswered_count: count,
          floor_minutes: FLOOR_MINUTES,
          ceiling_hours: CEILING_HOURS,
          oldest_user_msg_brt: r.oldest_brt,
        },
        notificationText:
          `${severity === 'critical' ? '🔴' : '🟡'} *${label}* — ` +
          `${count} cliente(s) Instagram DM sem resposta da IA ` +
          `(mais antigo: ${r.oldest_brt} BRT). ` +
          `Pipeline pode ter falhado silenciosamente — checar logs e responder manual.`,
      };
    });
  }
}
