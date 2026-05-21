import {
  Dimension,
  DimensionContext,
  DimensionResult,
} from '../types.js';
import { OPERATIONS, WINDOW } from '../config.js';

/**
 * Operations = quantos findings do health-check técnico tocaram esse tenant.
 *
 * Lê do DB `monitors` (`health_check_findings`). Diferente das outras
 * dimensões, aqui o valor absoluto importa — 1 finding já é ruído, 6+ vira
 * problema sistêmico. A média 7d serve só pra contexto.
 */
export class OperationsDimension implements Dimension {
  readonly code = 'operations' as const;

  async run(ctx: DimensionContext): Promise<DimensionResult> {
    const { db, tenant, window } = ctx;

    const [today] = await db.query<{
      findings: string;
      critical: string;
      checks: string;
    }>(
      `
      SELECT
        COUNT(*)::text AS findings,
        COUNT(*) FILTER (WHERE severity = 'critical')::text AS critical,
        COUNT(DISTINCT check_code)::text AS checks
      FROM health_check_findings
      WHERE tenant_id::text = $1
        AND created_at >= $2
        AND created_at <  $3
      `,
      [tenant.id, window.currentStart, window.currentEnd],
      'monitors',
    );

    const [baseline] = await db.query<{ findings: string }>(
      `
      SELECT COUNT(*)::text AS findings
      FROM health_check_findings
      WHERE tenant_id::text = $1
        AND created_at >= $2
        AND created_at <  $3
      `,
      [tenant.id, window.baselineStart, window.baselineEnd],
      'monitors',
    );

    // Quais check_codes apareceram hoje (pra raw_data)
    const checkRows = await db.query<{ check_code: string; count: string }>(
      `
      SELECT check_code, COUNT(*)::text AS count
      FROM health_check_findings
      WHERE tenant_id::text = $1
        AND created_at >= $2
        AND created_at <  $3
      GROUP BY check_code
      ORDER BY COUNT(*) DESC
      `,
      [tenant.id, window.currentStart, window.currentEnd],
      'monitors',
    );

    const findingsToday = Number(today?.findings ?? 0);
    const criticalToday = Number(today?.critical ?? 0);
    const checksToday = Number(today?.checks ?? 0);
    const findingsBaseline = Number(baseline?.findings ?? 0);
    const baselineAvg = findingsBaseline / WINDOW.baselineDays;

    const status = classifyOps(findingsToday, criticalToday);
    const deltaPct =
      baselineAvg > 0
        ? ((findingsToday - baselineAvg) / baselineAvg) * 100
        : findingsToday > 0
          ? 100
          : null;

    const narrative = narrateOps(
      findingsToday,
      criticalToday,
      checksToday,
      baselineAvg,
      status,
    );

    return {
      dimension: 'operations',
      currentValue: findingsToday,
      baselineValue: round2(baselineAvg),
      deltaPct: deltaPct === null ? null : round2(deltaPct),
      status,
      narrative,
      rawData: {
        findings_today: findingsToday,
        critical_today: criticalToday,
        distinct_checks_today: checksToday,
        findings_baseline_total: findingsBaseline,
        findings_baseline_avg: round2(baselineAvg),
        check_breakdown: checkRows.reduce<Record<string, number>>(
          (acc, r) => {
            acc[r.check_code] = Number(r.count);
            return acc;
          },
          {},
        ),
      },
    };
  }
}

function classifyOps(
  findings: number,
  critical: number,
): DimensionResult['status'] {
  if (critical >= 1) return 'critical';
  if (findings >= OPERATIONS.criticalMin) return 'critical';
  if (findings > OPERATIONS.attentionMax) return 'attention';
  if (findings > OPERATIONS.neutralMax) return 'neutral';
  return 'positive';
}

function narrateOps(
  findings: number,
  critical: number,
  checks: number,
  baselineAvg: number,
  status: DimensionResult['status'],
): string {
  if (findings === 0) {
    return 'Sem incidentes técnicos hoje.';
  }
  const baselineHint =
    baselineAvg > 0
      ? ` (média 7d: ${round2(baselineAvg)})`
      : '';
  if (status === 'critical') {
    const reason =
      critical >= 1
        ? `${critical} crítico(s)`
        : `${findings} incidentes em ${checks} categorias`;
    return `Saúde operacional comprometida — ${reason}${baselineHint}.`;
  }
  if (status === 'attention') {
    return `${findings} incidentes técnicos em ${checks} categorias${baselineHint}.`;
  }
  return `${findings} incidente(s) técnico(s) hoje${baselineHint}.`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
