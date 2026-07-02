import {
  Dimension,
  DimensionContext,
  DimensionResult,
} from '../types.js';
import { OPERATIONS, WINDOW } from '../config.js';

/**
 * Operations = quantos casos técnicos abertos tocam esse tenant.
 *
 * Lê do DB `monitors` (`health_check_findings`). O health-check roda a cada
 * 30min e grava 1 finding por check_code ENQUANTO a condição persiste — então
 * um único caso preso vira ~48 rows/dia. Contar rows (COUNT(*)) superconta o
 * mesmo problema e faz 1 caso parecer dezenas de incidentes. O número real de
 * casos abertos é o `metric_value` do snapshot MAIS RECENTE de cada check_code
 * na janela.
 *
 * Diferente das outras dimensões, aqui o valor absoluto importa — 1 caso já é
 * ruído, 6+ vira problema sistêmico. A média 7d serve só pra contexto.
 */
export class OperationsDimension implements Dimension {
  readonly code = 'operations' as const;

  async run(ctx: DimensionContext): Promise<DimensionResult> {
    const { db, tenant, window } = ctx;

    // Último snapshot de cada check_code na janela = estado real de casos
    // abertos (não o número de vezes que o monitor rodou).
    const latestRows = await db.query<{
      check_code: string;
      metric_value: string | null;
      severity: string;
    }>(
      `
      SELECT DISTINCT ON (check_code)
        check_code,
        metric_value::text AS metric_value,
        severity
      FROM health_check_findings
      WHERE tenant_id::text = $1
        AND created_at >= $2
        AND created_at <  $3
      ORDER BY check_code, created_at DESC
      `,
      [tenant.id, window.currentStart, window.currentEnd],
      'monitors',
    );

    // Baseline = média diária de casos abertos nos últimos 7d. Mesmo cuidado:
    // por dia, pega o último snapshot de cada check_code antes de somar.
    const [baseline] = await db.query<{ cases: string }>(
      `
      WITH per_day AS (
        SELECT DISTINCT ON (date_trunc('day', created_at), check_code)
          metric_value
        FROM health_check_findings
        WHERE tenant_id::text = $1
          AND created_at >= $2
          AND created_at <  $3
        ORDER BY date_trunc('day', created_at), check_code, created_at DESC
      )
      SELECT COALESCE(SUM(COALESCE(metric_value, 0)), 0)::text AS cases
      FROM per_day
      `,
      [tenant.id, window.baselineStart, window.baselineEnd],
      'monitors',
    );

    const findingsToday = latestRows.reduce(
      (sum, r) => sum + Number(r.metric_value ?? 0),
      0,
    );
    const criticalToday = latestRows.filter(
      (r) => r.severity === 'critical',
    ).length;
    const checksToday = latestRows.filter(
      (r) => Number(r.metric_value ?? 0) > 0,
    ).length;
    const findingsBaseline = Number(baseline?.cases ?? 0);
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
        check_breakdown: latestRows.reduce<Record<string, number>>(
          (acc, r) => {
            acc[r.check_code] = Number(r.metric_value ?? 0);
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
