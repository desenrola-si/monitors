import { injectable, inject } from 'inversify';
import { TYPES } from '../types.js';
import { Database } from '../database.js';

export type FindingSeverity = 'warning' | 'critical';

export interface InsertFindingArgs {
  healthCheckRunId: string;
  tenantId: string;
  tenantName: string | null;
  checkCode: string;
  severity: FindingSeverity;
  metricValue: number | null;
  payload: Record<string, unknown>;
}

@injectable()
export class HealthCheckRepository {
  constructor(@inject(TYPES.Database) private readonly db: Database) {}

  async startRun(jobRunId: string | null): Promise<string> {
    const rows = await this.db.query<{ id: string }>(
      `
      INSERT INTO health_check_runs (job_run_id, started_at)
      VALUES ($1, NOW())
      RETURNING id::text AS id
      `,
      [jobRunId],
      'monitors',
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('startRun não retornou id');
    return id;
  }

  async finishRun(
    runId: string,
    args: {
      totalTenants: number;
      totalProblems: number;
      summary: Record<string, number>;
      durationMs: number;
    },
  ): Promise<void> {
    await this.db.query(
      `
      UPDATE health_check_runs
      SET finished_at = NOW(),
          duration_ms = $2,
          total_tenants_checked = $3,
          total_problems_found = $4,
          summary = $5::jsonb
      WHERE id = $1
      `,
      [
        runId,
        args.durationMs,
        args.totalTenants,
        args.totalProblems,
        JSON.stringify(args.summary),
      ],
      'monitors',
    );
  }

  async insertFindings(findings: InsertFindingArgs[]): Promise<void> {
    if (findings.length === 0) return;
    // Insert em batch: muitos VALUES numa única query
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const f of findings) {
      valuesSql.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb)`,
      );
      params.push(
        f.healthCheckRunId,
        f.tenantId,
        f.tenantName,
        f.checkCode,
        f.severity,
        f.metricValue,
        JSON.stringify(f.payload),
      );
    }
    await this.db.query(
      `
      INSERT INTO health_check_findings (
        health_check_run_id, tenant_id, tenant_name, check_code,
        severity, metric_value, payload
      )
      VALUES ${valuesSql.join(', ')}
      `,
      params,
      'monitors',
    );
  }

  async getLatestSummary(): Promise<{
    totalTenants: number;
    totalProblems: number;
    summary: Record<string, number>;
    startedAt: string;
  } | null> {
    const rows = await this.db.query<{
      total_tenants_checked: number;
      total_problems_found: number;
      summary: Record<string, number>;
      started_at: string;
    }>(
      `
      SELECT
        total_tenants_checked,
        total_problems_found,
        summary,
        TO_CHAR(started_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at
      FROM health_check_runs
      WHERE finished_at IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 1
      `,
      [],
      'monitors',
    );
    const r = rows[0];
    if (!r) return null;
    return {
      totalTenants: r.total_tenants_checked,
      totalProblems: r.total_problems_found,
      summary: r.summary,
      startedAt: r.started_at,
    };
  }
}
