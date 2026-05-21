import { injectable, inject } from 'inversify';
import { TYPES } from '../types.js';
import { Database } from '../database.js';

export type SignalStatus =
  | 'positive'
  | 'neutral'
  | 'attention'
  | 'critical'
  | 'unknown';

export type OverallStatus = 'excellent' | 'healthy' | 'attention' | 'risk';

export interface InsertSnapshotArgs {
  reportDate: string; // YYYY-MM-DD
  tenantId: string;
  tenantName: string | null;
  aiConfigured: boolean;
  overallStatus: OverallStatus;
  overallNarrative: string | null;
  llmModel: string | null;
  llmTokensInput: number | null;
  llmTokensOutput: number | null;
}

export interface InsertSignalArgs {
  snapshotId: string;
  dimension: 'volume' | 'frustration' | 'conversion' | 'operations';
  currentValue: number | null;
  baselineValue: number | null;
  deltaPct: number | null;
  signalStatus: SignalStatus;
  narrative: string | null;
  rawData: Record<string, unknown>;
}

@injectable()
export class PortfolioRepository {
  constructor(@inject(TYPES.Database) private readonly db: Database) {}

  async insertSnapshot(args: InsertSnapshotArgs): Promise<string> {
    const rows = await this.db.query<{ id: string }>(
      `
      INSERT INTO portfolio_snapshots (
        report_date, tenant_id, tenant_name, ai_configured,
        overall_status, overall_narrative,
        llm_model, llm_tokens_input, llm_tokens_output
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (tenant_id, report_date) DO UPDATE SET
        overall_status = EXCLUDED.overall_status,
        overall_narrative = EXCLUDED.overall_narrative,
        llm_model = EXCLUDED.llm_model,
        llm_tokens_input = EXCLUDED.llm_tokens_input,
        llm_tokens_output = EXCLUDED.llm_tokens_output,
        ai_configured = EXCLUDED.ai_configured,
        tenant_name = EXCLUDED.tenant_name,
        created_at = NOW()
      RETURNING id::text AS id
      `,
      [
        args.reportDate,
        args.tenantId,
        args.tenantName,
        args.aiConfigured,
        args.overallStatus,
        args.overallNarrative,
        args.llmModel,
        args.llmTokensInput,
        args.llmTokensOutput,
      ],
      'desenrola',
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('insertSnapshot não retornou id');
    return id;
  }

  async deleteSignalsForSnapshot(snapshotId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM portfolio_signals WHERE snapshot_id = $1`,
      [snapshotId],
      'desenrola',
    );
  }

  async insertSignals(signals: InsertSignalArgs[]): Promise<void> {
    if (signals.length === 0) return;
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const s of signals) {
      valuesSql.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb)`,
      );
      params.push(
        s.snapshotId,
        s.dimension,
        s.currentValue,
        s.baselineValue,
        s.deltaPct,
        s.signalStatus,
        s.narrative,
        JSON.stringify(s.rawData),
      );
    }
    await this.db.query(
      `
      INSERT INTO portfolio_signals (
        snapshot_id, dimension, current_value, baseline_value, delta_pct,
        signal_status, narrative, raw_data
      )
      VALUES ${valuesSql.join(', ')}
      `,
      params,
      'desenrola',
    );
  }
}
