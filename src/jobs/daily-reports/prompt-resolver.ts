import { workflowPool } from './db.js';

interface WorkflowStep {
  type: string;
  config?: {
    system_prompt?: string;
    prompt?: string;
    model?: string;
  };
}

interface WorkflowDefinitionJson {
  steps?: WorkflowStep[];
}

export interface TenantPrompt {
  workflowDefinitionId: string;
  workflowSlug: string;
  systemPrompt: string;
  modelHint: string | null;
}

/**
 * Resolve o system_prompt do tenant lendo workflow_definitions pelo slug
 * (que vem das contas ativas — whatsapp_accounts.workflow_slug ou
 * instagram_accounts.workflow_slug). workflow_definitions.tenant_id NÃO é
 * fonte de verdade pra qual tenant da app usa qual workflow.
 *
 * Retorna null se não houver workflow ativo com aquele slug ou se nenhum step
 * de IA tiver system_prompt preenchido.
 */
export async function resolveTenantPrompt(
  workflowSlug: string,
): Promise<TenantPrompt | null> {
  const { rows } = await workflowPool.query<{
    id: string;
    slug: string;
    definition: WorkflowDefinitionJson;
  }>(
    `
      SELECT id::text AS id, slug, definition
      FROM workflow_definitions
      WHERE slug = $1
        AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [workflowSlug],
  );

  const wf = rows[0];
  if (!wf || !wf.definition || !Array.isArray(wf.definition.steps)) {
    return null;
  }

  const aiStep = wf.definition.steps.find((s) => s.type === 'ai_processing');
  const systemPrompt = aiStep?.config?.system_prompt?.trim();

  if (!systemPrompt) {
    return null;
  }

  return {
    workflowDefinitionId: wf.id,
    workflowSlug: wf.slug,
    systemPrompt,
    modelHint: aiStep?.config?.model ?? null,
  };
}
