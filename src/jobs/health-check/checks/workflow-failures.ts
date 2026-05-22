import { Check, CheckContext, CheckResult } from '../check.js';

const MIN_FAILURES = 3;
const WINDOW_MINUTES = 30;

/**
 * Detecta tenants com >= 3 workflow_executions com status=failed
 * nos últimos 30min. Inclui timeouts (que entram em failed com
 * error_message mencionando timeout).
 *
 * Sinal de problema sistêmico: provider LLM lento/quebrado, schema
 * mudou, credencial expirou, etc.
 */
export class WorkflowFailuresCheck implements Check {
  readonly code = 'workflow_failure_burst';
  readonly alertTypeCode = 'workflow_failure_burst' as const;
  readonly description = 'Workflows falhando em sequência';

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const rows = await ctx.db.query<{
      tenant_id: string;
      failure_count: string;
      timeout_count: string;
      last_error: string | null;
      last_failure_at: string;
    }>(
      `
      SELECT
        we.tenant_id,
        COUNT(*)::text AS failure_count,
        COUNT(*) FILTER (WHERE we.error_message ILIKE '%timeout%')::text AS timeout_count,
        (
          SELECT we2.error_message
          FROM workflow_executions we2
          WHERE we2.tenant_id = we.tenant_id
            AND we2.status = 'failed'
            AND we2.created_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
          ORDER BY we2.created_at DESC LIMIT 1
        ) AS last_error,
        TO_CHAR((MAX(we.created_at) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS last_failure_at
      FROM workflow_executions we
      WHERE we.status = 'failed'
        AND we.created_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
      GROUP BY we.tenant_id
      HAVING COUNT(*) >= ${MIN_FAILURES}
      ORDER BY COUNT(*) DESC
      `,
      [],
      'workflow_processor',
    );

    if (rows.length === 0) return [];

    // Resolve tenant names em batch contra DB desenrola
    const tenantIds = rows.map((r) => r.tenant_id);
    const namesRows = await ctx.db.query<{ id: string; name: string }>(
      `SELECT id::text AS id, name FROM tenants WHERE id::text = ANY($1)`,
      [tenantIds],
      'desenrola',
    );
    const namesById = new Map(namesRows.map((n) => [n.id, n.name]));

    return rows.map<CheckResult>((r) => {
      const count = Number(r.failure_count);
      const timeouts = Number(r.timeout_count);
      const severity = count >= 10 ? 'critical' : 'warning';
      const name = namesById.get(r.tenant_id) ?? null;
      const label = name ?? r.tenant_id;
      const kind = timeouts >= count / 2 ? 'timeouts' : 'falhas';
      return {
        tenantId: r.tenant_id,
        tenantName: name,
        severity,
        metricValue: count,
        payload: {
          failure_count: count,
          timeout_count: timeouts,
          window_minutes: WINDOW_MINUTES,
          last_error: r.last_error?.slice(0, 200) ?? null,
          last_failure_brt: r.last_failure_at,
        },
        notificationText:
          `${severity === 'critical' ? '🔴' : '🟡'} *${label}* — ` +
          `${count} ${kind} de workflow nos últimos ${WINDOW_MINUTES}min ` +
          `(último às ${r.last_failure_at} BRT). ` +
          (r.last_error
            ? `Causa: _${r.last_error.slice(0, 120)}_`
            : ''),
      };
    });
  }
}
