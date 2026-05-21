import { Check, CheckContext, CheckResult } from '../check.js';

const OVERDUE_MINUTES = 60;
const MIN_OVERDUE = 3;

export class CrmAutomationStepOverdueCheck implements Check {
  readonly code = 'crm_automation_step_overdue';
  readonly alertTypeCode = 'crm_automation_step_overdue' as const;
  readonly description = 'Passos de automação atrasados (BullMQ/scheduler pode estar travado)';

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const rows = await ctx.db.query<{
      tenant_id: string;
      tenant_name: string | null;
      overdue_count: string;
      oldest_scheduled_at: string;
    }>(
      `
      SELECT
        ae.tenant_id,
        t.name AS tenant_name,
        COUNT(*)::text AS overdue_count,
        TO_CHAR(MIN(se.scheduled_at) AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS oldest_scheduled_at
      FROM automation_step_executions se
      JOIN automation_enrollments ae ON ae.id = se.enrollment_id
      LEFT JOIN tenants t ON t.id::text = ae.tenant_id
      WHERE se.status = 'PENDING'
        AND se.scheduled_at < NOW() - INTERVAL '${OVERDUE_MINUTES} minutes'
      GROUP BY ae.tenant_id, t.name
      HAVING COUNT(*) >= ${MIN_OVERDUE}
      ORDER BY COUNT(*) DESC
      `,
      [],
      'desenrola',
    );

    return rows.map<CheckResult>((r) => {
      const count = Number(r.overdue_count);
      const severity = count >= 10 ? 'critical' : 'warning';
      const label = r.tenant_name ?? r.tenant_id;
      return {
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        severity,
        metricValue: count,
        payload: {
          overdue_count: count,
          threshold_minutes: OVERDUE_MINUTES,
          oldest_scheduled_brt: r.oldest_scheduled_at,
        },
        notificationText:
          `${severity === 'critical' ? '🔴' : '🟡'} *${label}* — ` +
          `${count} passos de automação atrasados há mais de ${OVERDUE_MINUTES}min ` +
          `(mais antigo agendado pra ${r.oldest_scheduled_at} BRT). ` +
          `Scheduler/BullMQ pode estar travado.`,
      };
    });
  }
}
