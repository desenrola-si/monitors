import { Check, CheckContext, CheckResult } from '../check.js';

const WINDOW_HOURS = 24;
const TOLERANCE_MINUTES = 60;

/**
 * Detecta reservas finais onde reservation.date diverge significativamente
 * do dateTime registrado em reservation_events.data (bug Fornalle +3h).
 */
export class ReservationOutsideSlotCheck implements Check {
  readonly code = 'reservation_outside_slot';
  readonly alertTypeCode = 'reservation_outside_slot' as const;
  readonly description = 'Reserva final diverge do horário pedido pelo cliente';

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const rows = await ctx.db.query<{
      tenant_id: string;
      tenant_name: string | null;
      mismatch_count: string;
      sample_reservation_id: string;
      sample_diff_min: string;
    }>(
      `
      WITH event_dates AS (
        SELECT
          re.reservation_id,
          re.tenant_id,
          (re.data->>'dateTime')::timestamptz AS event_dt
        FROM reservation_events re
        WHERE re.data ? 'dateTime'
          AND re.created_at >= NOW() - INTERVAL '${WINDOW_HOURS} hours'
      ),
      mismatches AS (
        SELECT
          r."tenantId" AS tenant_id,
          r.id AS reservation_id,
          ABS(EXTRACT(EPOCH FROM (r.date - ed.event_dt)) / 60) AS diff_min
        FROM reservations r
        JOIN event_dates ed ON ed.reservation_id = r.id
        WHERE r.created_at >= NOW() - INTERVAL '${WINDOW_HOURS} hours'
          AND r.status = 'CONFIRMED'
          AND ABS(EXTRACT(EPOCH FROM (r.date - ed.event_dt)) / 60) > ${TOLERANCE_MINUTES}
      )
      SELECT
        m.tenant_id,
        t.name AS tenant_name,
        COUNT(*)::text AS mismatch_count,
        (ARRAY_AGG(m.reservation_id))[1] AS sample_reservation_id,
        ROUND(MAX(m.diff_min))::text AS sample_diff_min
      FROM mismatches m
      LEFT JOIN tenants t ON t.id::text = m.tenant_id
      GROUP BY m.tenant_id, t.name
      ORDER BY COUNT(*) DESC
      `,
      [],
      'desenrola',
    );

    return rows.map<CheckResult>((r) => {
      const count = Number(r.mismatch_count);
      const diffMin = Number(r.sample_diff_min);
      const severity = count >= 3 ? 'critical' : 'warning';
      const label = r.tenant_name ?? r.tenant_id;
      return {
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        severity,
        metricValue: count,
        payload: {
          mismatch_count: count,
          window_hours: WINDOW_HOURS,
          tolerance_minutes: TOLERANCE_MINUTES,
          sample_reservation_id: r.sample_reservation_id,
          max_diff_minutes: diffMin,
        },
        notificationText:
          `${severity === 'critical' ? '🔴' : '🟡'} *${label}* — ` +
          `${count} reserva(s) confirmada(s) com horário divergente do pedido ` +
          `(diff de até ${diffMin}min). ` +
          `Exemplo: ${r.sample_reservation_id}. Possível bug de timezone.`,
      };
    });
  }
}
