import {
  Dimension,
  DimensionContext,
  DimensionResult,
} from '../types.js';
import { CONVERSION } from '../config.js';

/**
 * Conversion = reservations CONFIRMED / service_sessions iniciadas no mesmo dia.
 *
 * Não é perfeito (uma sessão pode virar reserva no dia seguinte) mas é uma
 * boa aproximação de eficácia diária. Usamos mesma janela pra current e
 * baseline pra que o lag se cancele.
 */
export class ConversionDimension implements Dimension {
  readonly code = 'conversion' as const;

  async run(ctx: DimensionContext): Promise<DimensionResult> {
    const { db, tenant, window } = ctx;

    const [today] = await db.query<{ reservations: string; sessions: string }>(
      `
      SELECT
        (
          SELECT COUNT(*)
          FROM reservations
          WHERE "tenantId"::text = $1
            AND status = 'CONFIRMED'
            AND created_at >= $2
            AND created_at <  $3
        )::text AS reservations,
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
      reservations: string;
      sessions: string;
    }>(
      `
      SELECT
        (
          SELECT COUNT(*)
          FROM reservations
          WHERE "tenantId"::text = $1
            AND status = 'CONFIRMED'
            AND created_at >= $2
            AND created_at <  $3
        )::text AS reservations,
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

    const reservToday = Number(today?.reservations ?? 0);
    const sessToday = Number(today?.sessions ?? 0);
    const reservBase = Number(baseline?.reservations ?? 0);
    const sessBase = Number(baseline?.sessions ?? 0);

    const rateToday = sessToday > 0 ? reservToday / sessToday : 0;
    const rateBase = sessBase > 0 ? reservBase / sessBase : 0;

    if (sessBase < CONVERSION.minSessionsToScore && sessToday < CONVERSION.minSessionsToScore) {
      return {
        dimension: 'conversion',
        currentValue: this.round2(rateToday * 100),
        baselineValue: this.round2(rateBase * 100),
        deltaPct: null,
        status: 'unknown',
        narrative:
          sessBase === 0 && sessToday === 0
            ? 'Sem sessões pra calcular conversão.'
            : `Sessões insuficientes pra avaliar conversão (precisa pelo menos ${CONVERSION.minSessionsToScore}/janela).`,
        rawData: {
          reservations_today: reservToday,
          sessions_today: sessToday,
          reservations_baseline: reservBase,
          sessions_baseline: sessBase,
        },
      };
    }

    const deltaPct =
      rateBase > 0
        ? ((rateToday - rateBase) / rateBase) * 100
        : rateToday > 0
          ? 100
          : 0;

    const status = this.classifyConversion(deltaPct, rateBase, rateToday);
    const narrative = this.narrateConversion(
      reservToday,
      sessToday,
      rateToday,
      rateBase,
      deltaPct,
      status,
    );

    return {
      dimension: 'conversion',
      currentValue: this.round2(rateToday * 100),
      baselineValue: this.round2(rateBase * 100),
      deltaPct: this.round2(deltaPct),
      status,
      narrative,
      rawData: {
        reservations_today: reservToday,
        sessions_today: sessToday,
        rate_today_pct: this.round2(rateToday * 100),
        reservations_baseline: reservBase,
        sessions_baseline: sessBase,
        baseline_rate_pct: this.round2(rateBase * 100),
      },
    };
  }

  private classifyConversion(
    deltaPct: number,
    rateBase: number,
    rateToday: number,
  ): DimensionResult['status'] {
    if (rateBase === 0 && rateToday > 0) return 'positive';
    if (rateBase === 0 && rateToday === 0) return 'neutral';
    if (deltaPct <= -CONVERSION.criticalDropPct) return 'critical';
    if (deltaPct <= -CONVERSION.attentionDropPct) return 'attention';
    if (deltaPct >= CONVERSION.positiveGrowthPct) return 'positive';
    return 'neutral';
  }

  private narrateConversion(
    reservToday: number,
    sessToday: number,
    rateToday: number,
    rateBase: number,
    deltaPct: number,
    status: DimensionResult['status'],
  ): string {
    const ratePctToday = this.round2(rateToday * 100);
    const ratePctBase = this.round2(rateBase * 100);
    const base = `${reservToday} reservas em ${sessToday} sessões (${ratePctToday}%) vs ${ratePctBase}% nos últimos 7d`;
    if (status === 'critical') return `Conversão despencou — ${base}.`;
    if (status === 'attention') return `Conversão em queda — ${base}.`;
    if (status === 'positive') return `Conversão em alta — ${base}.`;
    return `Conversão estável — ${base}.`;
  }

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }
}
