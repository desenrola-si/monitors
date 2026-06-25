import { logger } from './logger.js';
import { ActiveTenant, getTenantById, listActiveTenants } from './tenants.js';
import { resolveTenantPrompt } from './prompt-resolver.js';
import { collectMetrics } from './metrics/collect.js';
import { generateReport } from './llm.js';
import { getTenantMemory } from './memory.js';
import { REPORT_META_SYSTEM_PROMPT, buildUserPrompt } from './report-prompt.js';
import {
  REPORT_META_SYSTEM_PROMPT_HUMAN,
  buildUserPromptHuman,
} from './report-prompt-human.js';
import { existsCompletedReport, saveReport } from './save.js';
import {
  classifyUnanswered,
  fetchUnansweredCandidates,
  type ClassifiedUnanswered,
} from './metrics/classify-unanswered.js';
import type { CollectedMetrics } from './metrics/types.js';
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
  const aiCount = tenants.filter((t) => t.mode === 'ai').length;
  const humanCount = tenants.filter((t) => t.mode === 'human').length;

  logger.info(
    `Ciclo iniciado: reportDate=${reportDate} tenants=${tenants.length} ` +
      `(ai=${aiCount}, humano=${humanCount}) force=${opts.force ? 'true' : 'false'}`,
  );

  const summary: RunOnceSummary = {
    reportDate,
    total: tenants.length,
    generated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const tenant of tenants) {
    const label = `${tenant.name ?? tenant.id} (${tenant.id}, mode=${tenant.mode})`;

    try {
      if (!opts.force) {
        const already = await existsCompletedReport(tenant.id, reportDate);
        if (already) {
          logger.info(`[skip] ${label} — já existe relatório completed`);
          summary.skipped += 1;
          continue;
        }
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
      throw new Error(`Tenant não encontrado ou sem canal ativo: ${tenantId}`);
    }
    return [single];
  }
  return listActiveTenants();
}

async function generateOneReport(
  tenant: ActiveTenant,
  reportDate: string,
): Promise<void> {
  const [metrics, tenantMemory, bannedPhrases] = await Promise.all([
    collectMetrics(tenant, reportDate),
    getTenantMemory(tenant.id),
    loadBannedPhrases(tenant.id),
  ]);

  // Modo humano: traz os clientes sem nenhuma resposta no dia e deixa o LLM
  // julgar quais EXIGIAM resposta (descarta saudação solta / despedida).
  // A contagem final (needsReplyCount) é determinística sobre o veredito.
  let unanswered: ClassifiedUnanswered | null = null;
  if (tenant.mode === 'human') {
    const candidates = await fetchUnansweredCandidates(tenant.id, reportDate);
    unanswered = await classifyUnanswered(candidates);
  }

  const { systemPrompt, userPrompt } = await buildPrompts(
    tenant,
    metrics,
    tenantMemory,
    unanswered,
  );
  const systemPromptWithBans =
    systemPrompt + buildBannedPhrasesPromptSection(bannedPhrases);

  let llm = await generateReport({
    systemPrompt: systemPromptWithBans,
    userPrompt,
  });

  let matches = findMatches(llm.message, bannedPhrases);
  let totalTokensInput = llm.tokens.input + (unanswered?.tokens.input ?? 0);
  let totalTokensOutput = llm.tokens.output + (unanswered?.tokens.output ?? 0);

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

/**
 * Roteia construção de prompts por mode. AI usa o prompt operacional do bot
 * + meta prompt da IA; humano usa o meta prompt humano sem buscar prompt do
 * bot (não tem).
 */
async function buildPrompts(
  tenant: ActiveTenant,
  metrics: CollectedMetrics,
  tenantMemory: string,
  unanswered: ClassifiedUnanswered | null,
): Promise<{ systemPrompt: string; userPrompt: string }> {
  if (tenant.mode === 'human' && metrics.mode === 'human') {
    return {
      systemPrompt: REPORT_META_SYSTEM_PROMPT_HUMAN,
      userPrompt: buildUserPromptHuman({ tenantMemory, metrics, unanswered }),
    };
  }

  if (tenant.mode === 'ai' && metrics.mode === 'ai') {
    if (!tenant.workflowSlug) {
      throw new Error(
        `Tenant ${tenant.id} marcado como mode=ai mas sem workflow_slug.`,
      );
    }
    const prompt = await resolveTenantPrompt(tenant.workflowSlug);
    if (!prompt) {
      throw new Error(
        `Workflow ${tenant.workflowSlug} ativo não encontrado ou sem step ai_processing com system_prompt.`,
      );
    }
    return {
      systemPrompt: REPORT_META_SYSTEM_PROMPT,
      userPrompt: buildUserPrompt({
        tenantSystemPrompt: prompt.systemPrompt,
        tenantMemory,
        metrics,
      }),
    };
  }

  throw new Error(
    `Inconsistência: tenant.mode=${tenant.mode} mas metrics.mode=${metrics.mode}`,
  );
}

async function persistFailure(
  tenant: ActiveTenant,
  reportDate: string,
  errorMessage: string,
): Promise<void> {
  // Metric mínima — não tentamos recoletar
  const minimalMetrics = {
    mode: tenant.mode,
    reportDate,
    tenantId: tenant.id,
    tenantName: tenant.name,
    channels: {
      whatsapp: tenant.hasWhatsapp,
      instagram: tenant.hasInstagram,
      whatsappNumber: tenant.whatsappNumber,
      whatsappName: tenant.whatsappName,
      instagramHandle: tenant.instagramHandle,
    },
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
