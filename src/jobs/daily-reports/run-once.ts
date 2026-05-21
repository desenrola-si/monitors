import { logger } from './logger.js';
import { ActiveTenant, getTenantById, listActiveTenants } from './tenants.js';
import { resolveTenantPrompt } from './prompt-resolver.js';
import { collectMetrics } from './metrics/collect.js';
import { generateReport } from './llm.js';
import { getTenantMemory } from './memory.js';
import { REPORT_META_SYSTEM_PROMPT, buildUserPrompt } from './report-prompt.js';
import { existsCompletedReport, saveReport } from './save.js';
import {
  buildBannedPhrasesPromptSection,
  buildRetryWarning,
  decideFinalAction,
  findMatches,
  loadBannedPhrases,
} from './banned-phrases.js';

export interface RunOnceOptions {
  tenantId?: string;
  force?: boolean;
}

export interface RunOnceSummary {
  reportDate: string;
  total: number;
  generated: number;
  skipped: number;
  failed: number;
}

export async function runOnceForDate(
  reportDate: string,
  opts: RunOnceOptions = {},
): Promise<RunOnceSummary> {
  const tenants = await resolveTenants(opts.tenantId);

  logger.info(
    `Ciclo iniciado: reportDate=${reportDate} tenants=${tenants.length} force=${
      opts.force ? 'true' : 'false'
    }`,
  );

  const summary: RunOnceSummary = {
    reportDate,
    total: tenants.length,
    generated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const tenant of tenants) {
    const label = `${tenant.name ?? tenant.id} (${tenant.id})`;

    try {
      if (!opts.force) {
        const already = await existsCompletedReport(tenant.id, reportDate);
        if (already) {
          logger.info(`[skip] ${label} — já existe relatório completed`);
          summary.skipped += 1;
          continue;
        }
      }

      const inactiveReason = inactiveWorkflowReason(tenant);
      if (inactiveReason) {
        logger.info(`[skip] ${label} — ${inactiveReason}`);
        summary.skipped += 1;
        continue;
      }

      await generateOneReport(tenant, reportDate);
      summary.generated += 1;
      logger.info(`[ok]   ${label}`);
    } catch (err) {
      summary.failed += 1;
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`[fail] ${label}: ${errorMessage}`);
      await persistFailure(tenant, reportDate, errorMessage).catch((e) => {
        logger.error(
          `[fail] Não consegui persistir falha de ${label}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      });
    }
  }

  logger.info(
    `Ciclo terminado: total=${summary.total} gerados=${summary.generated} pulados=${summary.skipped} falhas=${summary.failed}`,
  );
  return summary;
}

async function resolveTenants(
  tenantId: string | undefined,
): Promise<ActiveTenant[]> {
  if (tenantId) {
    const single = await getTenantById(tenantId);
    if (!single) {
      throw new Error(`Tenant não encontrado ou inativo: ${tenantId}`);
    }
    return [single];
  }
  return listActiveTenants();
}

function inactiveWorkflowReason(tenant: ActiveTenant): string | null {
  if (!tenant.workflowSlug) {
    return 'sem workflow_slug ativo em nenhuma conta (whatsapp/instagram)';
  }
  if (tenant.workflowSlug.trim().toLowerCase().startsWith('todo')) {
    return `workflow placeholder (${tenant.workflowSlug})`;
  }
  return null;
}

async function generateOneReport(
  tenant: ActiveTenant,
  reportDate: string,
): Promise<void> {
  if (!tenant.workflowSlug) {
    throw new Error(
      `Tenant ${tenant.id} não tem workflow_slug ativo em nenhuma conta (whatsapp/instagram).`,
    );
  }
  const prompt = await resolveTenantPrompt(tenant.workflowSlug);
  if (!prompt) {
    throw new Error(
      `Workflow ${tenant.workflowSlug} ativo não encontrado ou sem step ai_processing com system_prompt.`,
    );
  }

  const [metrics, tenantMemory, bannedPhrases] = await Promise.all([
    collectMetrics(tenant, reportDate),
    getTenantMemory(tenant.id),
    loadBannedPhrases(tenant.id),
  ]);

  const userPrompt = buildUserPrompt({
    tenantSystemPrompt: prompt.systemPrompt,
    tenantMemory,
    metrics,
  });

  const systemPromptWithBans =
    REPORT_META_SYSTEM_PROMPT + buildBannedPhrasesPromptSection(bannedPhrases);

  let llm = await generateReport({
    systemPrompt: systemPromptWithBans,
    userPrompt,
  });

  let matches = findMatches(llm.message, bannedPhrases);
  let totalTokensInput = llm.tokens.input;
  let totalTokensOutput = llm.tokens.output;

  if (matches.length > 0) {
    logger.warn(
      `[${tenant.id}] Banned phrases no primeiro output (${matches
        .map((m) => `"${m.phrase}"`)
        .join(', ')}). Tentando retry.`,
    );
    const retryUserPrompt = userPrompt + buildRetryWarning(matches);
    llm = await generateReport({
      systemPrompt: systemPromptWithBans,
      userPrompt: retryUserPrompt,
    });
    matches = findMatches(llm.message, bannedPhrases);
    totalTokensInput += llm.tokens.input;
    totalTokensOutput += llm.tokens.output;
  }

  if (matches.length > 0) {
    const action = decideFinalAction(matches);
    const matchedDescription = matches.map((m) => `"${m.phrase}"`).join(', ');
    const errMsg = `Banned phrases persistiram após retry: ${matchedDescription}`;

    if (action === 'fail') {
      logger.error(`[${tenant.id}] ${errMsg} — marcando como failed`);
      await saveReport({
        tenantId: tenant.id,
        reportDate,
        statusCode: 'failed',
        metrics,
        message: null,
        modelUsed: llm.model,
        tokensInput: totalTokensInput,
        tokensOutput: totalTokensOutput,
        errorMessage: errMsg,
      });
      return;
    }

    logger.warn(`[${tenant.id}] ${errMsg} — marcando como blocked`);
    await saveReport({
      tenantId: tenant.id,
      reportDate,
      statusCode: 'blocked',
      metrics,
      message: llm.message,
      modelUsed: llm.model,
      tokensInput: totalTokensInput,
      tokensOutput: totalTokensOutput,
      errorMessage: errMsg,
    });
    return;
  }

  await saveReport({
    tenantId: tenant.id,
    reportDate,
    statusCode: 'completed',
    metrics,
    message: llm.message,
    modelUsed: llm.model,
    tokensInput: totalTokensInput,
    tokensOutput: totalTokensOutput,
    errorMessage: null,
  });
}

async function persistFailure(
  tenant: ActiveTenant,
  reportDate: string,
  errorMessage: string,
): Promise<void> {
  // Persiste com metrics mínima — não tentamos re-coletar (já falhou no caminho normal)
  const minimalMetrics = {
    reportDate,
    tenantId: tenant.id,
    tenantName: tenant.name,
    channels: {
      whatsapp: tenant.hasWhatsapp,
      instagram: tenant.hasInstagram,
    },
    desenrola: null,
    workflow: null,
    collectedAt: new Date().toISOString(),
    error: errorMessage,
  } as unknown as Parameters<typeof saveReport>[0]['metrics'];

  await saveReport({
    tenantId: tenant.id,
    reportDate,
    statusCode: 'failed',
    metrics: minimalMetrics,
    message: null,
    modelUsed: null,
    tokensInput: null,
    tokensOutput: null,
    errorMessage,
  });
}
