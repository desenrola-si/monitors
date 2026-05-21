import {
  Dimension,
  DimensionContext,
  DimensionResult,
} from '../types.js';
import { FRUSTRATION, WINDOW } from '../config.js';

/**
 * Frustração = TAXA de escalações pra humano (sobre sessões).
 *
 * Proxy:
 *   - escalations_today = COUNT DISTINCT request_id em conversation_assignments
 *     com assigned_at no dia
 *   - sessions_today    = COUNT(*) em service_sessions started_at no dia
 *   - taxa              = escalations / sessions
 *
 * Comparamos a taxa atual vs taxa média dos últimos 7 dias.
 * Usar taxa em vez de absoluto evita falso positivo em dias de pico.
 */
export class FrustrationDimension implements Dimension {
  readonly code = 'frustration' as const;

  async run(ctx: DimensionContext): Promise<DimensionResult> {
    const { db, tenant, window } = ctx;

    const [today] = await db.query<{ escalations: string; sessions: string }>(
      `
      SELECT
        (
          SELECT COUNT(DISTINCT request_id)
          FROM conversation_assignments
          WHERE tenant_id::text = $1
            AND assigned_at >= $2
            AND assigned_at <  $3
        )::text AS escalations,
        (
          SELECT COUNT(*)
          FROM service_sessions
          WHERE tenant_id::text = $1
            AND started_at >= $2
            AND started_at <  $3
        )::text AS sessions
      `,
      [tenant.id, window.currentStart, window.currentEnd],
      'desenrola',
    );

    const [baseline] = await db.query<{
      escalations: string;
      sessions: string;
    }>(
      `
      SELECT
        (
          SELECT COUNT(DISTINCT request_id)
          FROM conversation_assignments
          WHERE tenant_id::text = $1
            AND assigned_at >= $2
            AND assigned_at <  $3
        )::text AS escalations,
        (
          SELECT COUNT(*)
          FROM service_sessions
          WHERE tenant_id::text = $1
            AND started_at >= $2
            AND started_at <  $3
        )::text AS sessions
      `,
      [tenant.id, window.baselineStart, window.baselineEnd],
      'desenrola',
    );

    const escalToday = Number(today?.escalations ?? 0);
    const sessToday = Number(today?.sessions ?? 0);
    const escalBase = Number(baseline?.escalations ?? 0);
    const sessBase = Number(baseline?.sessions ?? 0);

    const rateToday = sessToday > 0 ? escalToday / sessToday : 0;
    const rateBase = sessBase > 0 ? escalBase / sessBase : 0;

    // Sem dados pra comparar
    if (sessToday === 0 && sessBase === 0) {
      return {
        dimension: 'frustration',
        currentValue: 0,
        baselineValue: 0,
        deltaPct: null,
        status: 'unknown',
        narrative: 'Sem sessões hoje nem na semana — sem sinal de frustração.',
        rawData: { escalations_today: 0, sessions_today: 0 },
      };
    }

    // Tolerância pra volumes pequenos: 0 ou 1 escalação isolada não vira sinal
    if (escalToday <= FRUSTRATION.toleratedDailyEscalations && rateBase === 0) {
      return {
        dimension: 'frustration',
        currentValue: round2(rateToday * 100),
        baselineValue: 0,
        deltaPct: null,
        status: 'neutral',
        narrative:
          escalToday === 0
            ? 'Sem escalações pra humano hoje.'
            : `${escalToday} escalação no dia — dentro do esperado.`,
        rawData: {
          escalations_today: escalToday,
          sessions_today: sessToday,
          rate_today_pct: round2(rateToday * 100),
          baseline_total_escalations: escalBase,
          baseline_total_sessions: sessBase,
          baseline_avg_per_day:
            round2(escalBase / WINDOW.baselineDays),
        },
      };
    }

    // Crescimento relativo da taxa
    const deltaPct =
      rateBase > 0
        ? ((rateToday - rateBase) / rateBase) * 100
        : rateToday > 0
          ? 100
          : 0;

    const status = classifyFrustration(deltaPct, escalToday);
    const narrative = narrateFrustration(
      escalToday,
      sessToday,
      rateToday,
      rateBase,
      deltaPct,
      status,
    );

    return {
      dimension: 'frustration',
      currentValue: round2(rateToday * 100),
      baselineValue: round2(rateBase * 100),
      deltaPct: round2(deltaPct),
      status,
      narrative,
      rawData: {
        escalations_today: escalToday,
        sessions_today: sessToday,
        rate_today_pct: round2(rateToday * 100),
        baseline_total_escalations: escalBase,
        baseline_total_sessions: sessBase,
        baseline_rate_pct: round2(rateBase * 100),
        baseline_avg_per_day: round2(escalBase / WINDOW.baselineDays),
      },
    };
  }
}

function classifyFrustration(
  deltaPct: number,
  escalToday: number,
): DimensionResult['status'] {
  if (escalToday <= FRUSTRATION.toleratedDailyEscalations) return 'neutral';
  if (deltaPct >= FRUSTRATION.criticalGrowthPct) return 'critical';
  if (deltaPct >= FRUSTRATION.attentionGrowthPct) return 'attention';
  if (deltaPct <= -FRUSTRATION.attentionGrowthPct) return 'positive';
  return 'neutral';
}

function narrateFrustration(
  escalToday: number,
  sessToday: number,
  rateToday: number,
  rateBase: number,
  deltaPct: number,
  status: DimensionResult['status'],
): string {
  const ratePctToday = round2(rateToday * 100);
  const ratePctBase = round2(rateBase * 100);
  if (status === 'critical') {
    return `Escalações disparando — ${escalToday}/${sessToday} sessões (${ratePctToday}%) vs ${ratePctBase}% nos últimos 7d.`;
  }
  if (status === 'attention') {
    return `Mais escalações que o normal — ${escalToday}/${sessToday} (${ratePctToday}%) vs ${ratePctBase}% baseline.`;
  }
  if (status === 'positive') {
    return `Menos escalações que o normal — taxa caiu de ${ratePctBase}% pra ${ratePctToday}%.`;
  }
  return `${escalToday}/${sessToday} sessões escalaram hoje (${ratePctToday}%).`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
