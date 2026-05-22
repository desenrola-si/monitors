import { Check, CheckContext, CheckResult } from '../check.js';

const WINDOW_MINUTES = 60;
const MIN_FAILURES = 3;

export class CrmAutomationStepFailedCheck implements Check {
  readonly code = 'crm_automation_step_failed';
  readonly alertTypeCode = 'crm_automation_step_failed' as const;
  readonly description = 'Steps de automação do CRM falhando em volume';

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const rows = await ctx.db.query<{
      tenant_id: string;
      tenant_name: string | null;
      failure_count: string;
      last_error: string | null;
      last_at: string;
    }>(
      `
      SELECT
        ae.tenant_id,
        t.name AS tenant_name,
        COUNT(*)::text AS failure_count,
        (
          SELECT COALESCE(se2.result->>'error', se2.result->>'message')
          FROM automation_step_executions se2
          JOIN automation_enrollments ae2 ON ae2.id = se2.enrollment_id
          WHERE ae2.tenant_id = ae.tenant_id
            AND se2.status = 'FAILED'
            AND se2.executed_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
          ORDER BY se2.executed_at DESC LIMIT 1
        ) AS last_error,
        TO_CHAR((MAX(se.executed_at) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS last_at
      FROM automation_step_executions se
      JOIN automation_enrollments ae ON ae.id = se.enrollment_id
      LEFT JOIN tenants t ON t.id::text = ae.tenant_id
      WHERE se.status = 'FAILED'
        AND se.executed_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
      GROUP BY ae.tenant_id, t.name
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
          last_error: r.last_error?.slice(0, 200) ?? null,
          last_failure_brt: r.last_at,
        },
        notificationText:
          `${severity === 'critical' ? '🔴' : '🟡'} *${label}* — ` +
          `${count} passos de automação do CRM falharam na última hora ` +
          `(último às ${r.last_at} BRT). ` +
          (r.last_error ? `Causa: _${r.last_error.slice(0, 120)}_` : ''),
      };
    });
  }
}
