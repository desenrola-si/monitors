import { workflowPool } from '../db.js';
import { WorkflowMetrics } from './types.js';

export async function collectWorkflowMetrics(
  tenantId: string,
  reportDate: string,
): Promise<WorkflowMetrics> {
  const dayRange = {
    start: `('${reportDate}'::date) AT TIME ZONE 'America/Sao_Paulo'`,
    end: `('${reportDate}'::date + INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo'`,
  };

  const { rows: execRows } = await workflowPool.query<{
    total: string;
    completed: string;
    failed: string;
    timeout: string;
    other: string;
    avg_ms: string | null;
    p50: string | null;
    p95: string | null;
    max_ms: string | null;
  }>(
    `
      SELECT
        COUNT(*)::text                                                       AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::text          AS completed,
        SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END)::text          AS failed,
        SUM(CASE WHEN status = 'timeout'   THEN 1 ELSE 0 END)::text          AS timeout,
        SUM(CASE WHEN status NOT IN ('completed','failed','timeout')
            THEN 1 ELSE 0 END)::text                                          AS other,
        ROUND(AVG(duration_ms))::text                                         AS avg_ms,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms)::text       AS p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::text       AS p95,
        MAX(duration_ms)::text                                                AS max_ms
      FROM workflow_executions
      WHERE tenant_id = $1
        AND created_at >= ${dayRange.start}
        AND created_at <  ${dayRange.end}
    `,
    [tenantId],
  );

  const e = execRows[0];

  const { rows: toolRows } = await workflowPool.query<{
    tool: string;
    calls: string;
    success: string;
    failure: string;
  }>(
    `
      WITH tool_calls AS (
        SELECT jsonb_array_elements(
                 COALESCE(esl.metadata->'tool_calls','[]'::jsonb)
               ) AS tc
        FROM execution_step_logs esl
        JOIN workflow_executions we ON we.id = esl.workflow_execution_id
        WHERE we.tenant_id = $1
          AND we.created_at >= ${dayRange.start}
          AND we.created_at <  ${dayRange.end}
          AND esl.step_type = 'ai_processing'
      )
      SELECT
        (tc->>'tool')                                              AS tool,
        COUNT(*)::text                                             AS calls,
        SUM(CASE WHEN tc->'result'->>'success' = 'true'
            THEN 1 ELSE 0 END)::text                               AS success,
        SUM(CASE WHEN tc->'result'->>'success' IS NULL
                  OR tc->'result'->>'success' = 'false'
            THEN 1 ELSE 0 END)::text                               AS failure
      FROM tool_calls
      WHERE tc->>'tool' IS NOT NULL
      GROUP BY 1
      ORDER BY 2 DESC
    `,
    [tenantId],
  );

  const { rows: guardRows } = await workflowPool.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM execution_step_logs esl
      JOIN workflow_executions we ON we.id = esl.workflow_execution_id
      WHERE we.tenant_id = $1
        AND we.created_at >= ${dayRange.start}
        AND we.created_at <  ${dayRange.end}
        AND esl.step_type = 'ai_processing'
        AND jsonb_array_length(
              COALESCE(esl.metadata->'guard'->'initial_violations','[]'::jsonb)
            ) > 0
    `,
    [tenantId],
  );

  return {
    executions: {
      total: Number(e?.total ?? 0),
      completed: Number(e?.completed ?? 0),
      failed: Number(e?.failed ?? 0),
      timeout: Number(e?.timeout ?? 0),
      other: Number(e?.other ?? 0),
    },
    latencyMs: {
      avg: e?.avg_ms ? Number(e.avg_ms) : null,
      p50: e?.p50 ? Number(e.p50) : null,
      p95: e?.p95 ? Number(e.p95) : null,
      max: e?.max_ms ? Number(e.max_ms) : null,
    },
    toolUsage: toolRows.map((r) => ({
      tool: r.tool,
      calls: Number(r.calls),
      success: Number(r.success),
      failure: Number(r.failure),
    })),
    guardViolations: Number(guardRows[0]?.count ?? 0),
  };
}
