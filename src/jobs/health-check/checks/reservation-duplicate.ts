import { Check, CheckContext, CheckResult } from '../check.js';

const WINDOW_HOURS = 24;
const DUPLICATE_WINDOW_MINUTES = 10;

export class ReservationDuplicateCheck implements Check {
  readonly code = 'reservation_duplicate';
  readonly alertTypeCode = 'reservation_duplicate' as const;
  readonly description = 'Mesmo cliente com mais de uma reserva em poucos minutos';

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const rows = await ctx.db.query<{
      tenant_id: string;
      tenant_name: string | null;
      duplicates_count: string;
      phones: string[];
    }>(
      `
      WITH dup_groups AS (
        SELECT
          r."tenantId" AS tenant_id,
          r.phone_number,
          COUNT(*) AS cnt,
          MIN(r.created_at) AS first_at,
          MAX(r.created_at) AS last_at
        FROM reservations r
        WHERE r.created_at >= NOW() - INTERVAL '${WINDOW_HOURS} hours'
          AND r.phone_number IS NOT NULL
          AND r.status != 'REJECTED'
        GROUP BY r."tenantId", r.phone_number
        HAVING COUNT(*) >= 2
          AND EXTRACT(EPOCH FROM (MAX(r.created_at) - MIN(r.created_at))) < ${DUPLICATE_WINDOW_MINUTES * 60}
      )
      SELECT
        dg.tenant_id,
        t.name AS tenant_name,
        COUNT(*)::text AS duplicates_count,
        ARRAY_AGG(DISTINCT dg.phone_number) AS phones
      FROM dup_groups dg
      LEFT JOIN tenants t ON t.id::text = dg.tenant_id
      GROUP BY dg.tenant_id, t.name
      ORDER BY COUNT(*) DESC
      `,
      [],
      'desenrola',
    );

    return rows.map<CheckResult>((r) => {
      const count = Number(r.duplicates_count);
      const severity = count >= 3 ? 'critical' : 'warning';
      const label = r.tenant_name ?? r.tenant_id;
      const sample = r.phones.slice(0, 3).join(', ');
      return {
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        severity,
        metricValue: count,
        payload: {
          duplicate_groups: count,
          window_hours: WINDOW_HOURS,
          duplicate_window_minutes: DUPLICATE_WINDOW_MINUTES,
          affected_phones: r.phones,
        },
        notificationText:
          `${severity === 'critical' ? '🔴' : '🟡'} *${label}* — ` +
          `${count} cliente(s) com reserva duplicada em menos de ${DUPLICATE_WINDOW_MINUTES}min ` +
          `nas últimas ${WINDOW_HOURS}h. ` +
          `Telefones: ${sample}${r.phones.length > 3 ? ` (+${r.phones.length - 3})` : ''}.`,
      };
    });
  }
}
