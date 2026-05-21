import {
  Dimension,
  DimensionContext,
  DimensionResult,
} from '../types.js';
import { VOLUME, WINDOW } from '../config.js';

/**
 * Volume = sessões iniciadas pelo cliente no dia (service_sessions.started_at).
 * Funciona pra WhatsApp + Instagram juntos sem precisar de JOIN com instances.
 *
 * Score: compara contagem do dia atual vs média diária dos últimos 7 dias.
 */
export class VolumeDimension implements Dimension {
  readonly code = 'volume' as const;

  async run(ctx: DimensionContext): Promise<DimensionResult> {
    const { db, tenant, window } = ctx;

    const [current] = await db.query<{ count: string }>(
      `
      SELECT COUNT(*)::text AS count
      FROM service_sessions
      WHERE tenant_id::text = $1
        AND started_at >= $2
        AND started_at <  $3
      `,
      [tenant.id, window.currentStart, window.currentEnd],
      'desenrola',
    );

    const [baseline] = await db.query<{ count: string }>(
      `
      SELECT COUNT(*)::text AS count
      FROM service_sessions
      WHERE tenant_id::text = $1
        AND started_at >= $2
        AND started_at <  $3
      `,
      [tenant.id, window.baselineStart, window.baselineEnd],
      'desenrola',
    );

    const currentValue = Number(current?.count ?? 0);
    const baselineTotal = Number(baseline?.count ?? 0);
    const baselineAvg = baselineTotal / WINDOW.baselineDays;

    if (baselineAvg < VOLUME.minBaselineToScore) {
      return {
        dimension: 'volume',
        currentValue,
        baselineValue: round2(baselineAvg),
        deltaPct: null,
        status: 'unknown',
        narrative:
          baselineTotal === 0 && currentValue === 0
            ? 'Sem volume nos últimos 7 dias — tenant silencioso.'
            : `Volume baixo demais pra avaliar tendência (média 7d = ${round2(baselineAvg)} sessões/dia).`,
        rawData: {
          sessions_today: currentValue,
          sessions_baseline_total: baselineTotal,
          sessions_baseline_avg: round2(baselineAvg),
        },
      };
    }

    const deltaPct = ((currentValue - baselineAvg) / baselineAvg) * 100;
    const status = classifyVolume(deltaPct);
    const narrative = narrateVolume(currentValue, baselineAvg, deltaPct, status);

    return {
      dimension: 'volume',
      currentValue,
      baselineValue: round2(baselineAvg),
      deltaPct: round2(deltaPct),
      status,
      narrative,
      rawData: {
        sessions_today: currentValue,
        sessions_baseline_total: baselineTotal,
        sessions_baseline_avg: round2(baselineAvg),
      },
    };
  }
}

function classifyVolume(deltaPct: number): DimensionResult['status'] {
  if (deltaPct <= -VOLUME.criticalDropPct) return 'critical';
  if (deltaPct <= -VOLUME.attentionDropPct) return 'attention';
  if (deltaPct >= VOLUME.positiveGrowthPct) return 'positive';
  return 'neutral';
}

function narrateVolume(
  current: number,
  baselineAvg: number,
  deltaPct: number,
  status: DimensionResult['status'],
): string {
  const sign = deltaPct >= 0 ? '+' : '';
  const base = `${current} sessões hoje vs média de ${round2(baselineAvg)}/dia (${sign}${round2(deltaPct)}%)`;
  if (status === 'critical') return `Queda forte no volume — ${base}.`;
  if (status === 'attention') return `Volume em queda — ${base}.`;
  if (status === 'positive') return `Volume em alta — ${base}.`;
  return `Volume estável — ${base}.`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
