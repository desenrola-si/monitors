import { injectable, inject } from 'inversify';
import { TYPES } from '../types.js';
import { Database } from '../database.js';
import { computeCostUsd, isModelPriced } from '../pricing/model-pricing.js';

const BRL_RATE = 5.8;

export interface CostTokens {
  prompt: number;
  cached: number;
  completion: number;
}

export interface WorkflowCost {
  workflowDefinitionId: string | null;
  slug: string | null;
  name: string | null;
  tenantId: string;
  calls: number;
  tokens: CostTokens;
  usd: number;
  brl: number;
  unpricedCalls: number;
}

export interface ClientCost {
  tenantId: string;
  name: string | null;
  calls: number;
  tokens: CostTokens;
  usd: number;
  brl: number;
  unpricedCalls: number;
}

export interface CostTotals {
  calls: number;
  tokens: CostTokens;
  usd: number;
  brl: number;
  unpricedCalls: number;
}

export interface CostBreakdown {
  period: { from: string; to: string };
  total: CostTotals;
  byClient: ClientCost[];
  byWorkflow: WorkflowCost[];
}

interface AggRow {
  tenant_id: string;
  workflow_definition_id: string | null;
  workflow_name: string | null;
  workflow_slug: string | null;
  model: string | null;
  calls: string;
  prompt: string;
  cached: string;
  completion: string;
}

@injectable()
export class CostRepository {
  constructor(@inject(TYPES.Database) private readonly db: Database) {}

  async getBreakdown(from: string, to: string): Promise<CostBreakdown> {
    const rows = await this.db.query<AggRow>(
      `
      SELECT
        e.tenant_id::text                                   AS tenant_id,
        e.workflow_definition_id::text                      AS workflow_definition_id,
        d.name                                              AS workflow_name,
        d.slug                                              AS workflow_slug,
        s.metadata->>'model'                                AS model,
        count(*)                                            AS calls,
        sum((s.metadata->'usage'->>'promptTokens')::numeric)               AS prompt,
        sum(coalesce((s.metadata->'usage'->>'cachedTokens')::numeric, 0))  AS cached,
        sum((s.metadata->'usage'->>'completionTokens')::numeric)           AS completion
      FROM execution_step_logs s
      JOIN workflow_executions e ON e.id = s.workflow_execution_id
      LEFT JOIN workflow_definitions d ON d.id = e.workflow_definition_id
      WHERE s.step_type = 'ai_processing'
        AND s.metadata->'usage'->>'promptTokens' IS NOT NULL
        AND e.started_at >= $1::date
        AND e.started_at <  ($2::date + interval '1 day')
      GROUP BY 1, 2, 3, 4, 5
      `,
      [from, to],
      'workflow_processor',
    );

    const tenantNames = await this.lookupTenantNames(
      [...new Set(rows.map((r) => r.tenant_id))],
    );

    const byWorkflow = new Map<string, WorkflowCost>();
    const byClient = new Map<string, ClientCost>();
    const total: CostTotals = { calls: 0, tokens: zeroTokens(), usd: 0, brl: 0, unpricedCalls: 0 };

    for (const row of rows) {
      const tokens: CostTokens = {
        prompt: Number(row.prompt),
        cached: Number(row.cached),
        completion: Number(row.completion),
      };
      const calls = Number(row.calls);
      const usd =
        computeCostUsd(row.model, {
          promptTokens: tokens.prompt,
          cachedTokens: tokens.cached,
          completionTokens: tokens.completion,
        }) ?? 0;
      const unpriced = isModelPriced(row.model) ? 0 : calls;

      const wfKey = row.workflow_definition_id ?? `${row.tenant_id}:?`;
      const wf = byWorkflow.get(wfKey);
      if (wf) {
        addTokens(wf.tokens, tokens);
        wf.calls += calls;
        wf.usd += usd;
        wf.unpricedCalls += unpriced;
      } else {
        byWorkflow.set(wfKey, {
          workflowDefinitionId: row.workflow_definition_id,
          slug: row.workflow_slug,
          name: row.workflow_name,
          tenantId: row.tenant_id,
          calls,
          tokens: { ...tokens },
          usd,
          brl: 0,
          unpricedCalls: unpriced,
        });
      }

      const client = byClient.get(row.tenant_id);
      if (client) {
        addTokens(client.tokens, tokens);
        client.calls += calls;
        client.usd += usd;
        client.unpricedCalls += unpriced;
      } else {
        byClient.set(row.tenant_id, {
          tenantId: row.tenant_id,
          name: tenantNames.get(row.tenant_id) ?? null,
          calls,
          tokens: { ...tokens },
          usd,
          brl: 0,
          unpricedCalls: unpriced,
        });
      }

      addTokens(total.tokens, tokens);
      total.calls += calls;
      total.usd += usd;
      total.unpricedCalls += unpriced;
    }

    return {
      period: { from, to },
      total: withBrl(total),
      byClient: [...byClient.values()].map(withBrl).sort((a, b) => b.usd - a.usd),
      byWorkflow: [...byWorkflow.values()].map(withBrl).sort((a, b) => b.usd - a.usd),
    };
  }

  private async lookupTenantNames(tenantIds: string[]): Promise<Map<string, string>> {
    if (tenantIds.length === 0) return new Map();
    const rows = await this.db.query<{ id: string; name: string | null }>(
      `SELECT id::text AS id, name FROM tenants WHERE id::text = ANY($1::text[])`,
      [tenantIds],
      'desenrola',
    );
    return new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name as string]));
  }
}

function zeroTokens(): CostTokens {
  return { prompt: 0, cached: 0, completion: 0 };
}

function addTokens(target: CostTokens, src: CostTokens): void {
  target.prompt += src.prompt;
  target.cached += src.cached;
  target.completion += src.completion;
}

function withBrl<T extends { usd: number; brl: number }>(item: T): T {
  item.usd = round(item.usd, 4);
  item.brl = round(item.usd * BRL_RATE, 2);
  return item;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
