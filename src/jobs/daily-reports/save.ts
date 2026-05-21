import { desenrolaPool } from './db.js';
import { CollectedMetrics } from './metrics/types.js';
import { sanitizeUnicode, sanitizeUnicodeDeep } from './sanitize.js';

export type ReportStatusCode = 'completed' | 'failed' | 'blocked';

export interface SaveReportArgs {
  tenantId: string;
  reportDate: string;
  statusCode: ReportStatusCode;
  metrics: CollectedMetrics;
  message: string | null;
  modelUsed: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  errorMessage: string | null;
}

export async function existsCompletedReport(
  tenantId: string,
  reportDate: string,
): Promise<boolean> {
  const { rows } = await desenrolaPool.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM daily_tenant_reports r
        JOIN daily_report_statuses s ON s.id = r.status_id
        WHERE r.tenant_id = $1
          AND r.report_date = $2::date
          AND s.code = 'completed'
      ) AS exists
    `,
    [tenantId, reportDate],
  );
  return rows[0]?.exists === true;
}

export async function saveReport(args: SaveReportArgs): Promise<void> {
  await desenrolaPool.query(
    `
      INSERT INTO daily_tenant_reports (
        tenant_id,
        report_date,
        status_id,
        metrics,
        message,
        model_used,
        tokens_input,
        tokens_output,
        error_message,
        generated_at
      )
      VALUES (
        $1,
        $2::date,
        (SELECT id FROM daily_report_statuses WHERE code = $3),
        $4::jsonb,
        $5,
        $6,
        $7,
        $8,
        $9,
        now()
      )
      ON CONFLICT (tenant_id, report_date) DO UPDATE SET
        status_id     = EXCLUDED.status_id,
        metrics       = EXCLUDED.metrics,
        message       = EXCLUDED.message,
        model_used    = EXCLUDED.model_used,
        tokens_input  = EXCLUDED.tokens_input,
        tokens_output = EXCLUDED.tokens_output,
        error_message = EXCLUDED.error_message,
        generated_at  = EXCLUDED.generated_at,
        updated_at    = now()
    `,
    [
      args.tenantId,
      args.reportDate,
      args.statusCode,
      JSON.stringify(sanitizeUnicodeDeep(args.metrics)),
      args.message ? sanitizeUnicode(args.message) : args.message,
      args.modelUsed,
      args.tokensInput,
      args.tokensOutput,
      args.errorMessage
        ? sanitizeUnicode(args.errorMessage)
        : args.errorMessage,
    ],
  );
}
