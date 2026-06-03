import { injectable, inject } from 'inversify';
import { Job } from '../lib/job.js';
import { TYPES } from '../lib/types.js';
import { Logger } from '../lib/logger.js';
import { Database } from '../lib/database.js';
import { Notifier } from '../lib/notifier.js';
import { AlertsRepository, AlertTypeCode } from '../lib/repositories/alerts-repository.js';

const WINDOW_MINUTES = 6;
const EXPIRY_HOURS = 6;

const TRACKED_SLUGS = ['sunomono-conversas-kb-pilot'];

const COT_PATTERNS = [
  'vou seguir',
  'a regra diz',
  'preciso verificar',
  'identificando o motivo',
  'identificando a',
  'analisando sua mensagem',
  'analisando a mensagem',
  'classificando como',
  'classificando o',
  'seguir o fluxo',
  'deixa eu pensar',
  'o cliente enviou',
  'o cliente está',
  'tipo: reclamação',
  'urgência: ',
];

interface CotRow {
  execution_id: string;
  tenant_id: string;
  slug: string;
  response: string;
  started_at: string;
  matched_phrase: string;
}

interface ZeroChunksRow {
  execution_id: string;
  tenant_id: string;
  slug: string;
  query: string;
  started_at: string;
}

interface EarlyEscalationRow {
  execution_id: string;
  tenant_id: string;
  slug: string;
  user_message: string;
  started_at: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}min ${sec}s`;
}

/**
 * Monitor: qualidade do RAG dos workflows de IA com knowledge_base step.
 *
 * Contexto: depois do incidente CoT leak do Sunomono em 2026-06-03
 * (project_sunomono_cot_leak_2026_06_03), iniciamos migração dos
 * workflows do padrão "prompt monolítico" pro padrão "knowledge_base
 * + prompt enxuto" — começando pelo pilot sunomono-conversas-kb-pilot.
 *
 * Esse monitor vigia esse pilot (e novos workflows que entrarem em
 * TRACKED_SLUGS) detectando 3 famílias de regressão:
 *
 *   1. ai_rag_cot_leak  — resposta enviada ao cliente contém frases
 *      típicas de raciocínio interno ("vou seguir", "a regra diz",
 *      "identificando o motivo", etc). P0 — alerta toda detecção.
 *
 *   2. ai_rag_zero_chunks — step knowledge_base completou sem
 *      recuperar nenhum chunk. Indica query template ruim, threshold
 *      alto demais, ou pergunta fora do escopo da KB. Modelo respondeu
 *      sem contexto factual, alto risco de invenção.
 *
 *   3. ai_rag_early_human_escalation — request_human_intervention
 *      acionado já no primeiro turno (sem conversationHistory). IA
 *      escalando antes de tentar responder via KB. P1 mas indica que
 *      o prompt enxuto está orientando escalação cedo demais.
 *
 * O monitor lê do DB do workflow-processor (`WORKFLOW_PROCESSOR_DB_URL`)
 * e grava alerts no DB do monitors via AlertsRepository, com dedup
 * por (tenant, execução) — uma mesma execução não gera 2 alerts do
 * mesmo tipo.
 */
@injectable()
export class AiRagQualityMonitorJob extends Job {
  readonly name = 'ai-rag-quality-monitor';
  readonly displayName = 'Qualidade do RAG (sunomono pilot)';
  readonly description =
    'Vigia workflows com knowledge_base step (sunomono-conversas-kb-pilot) ' +
    'detectando vazamento de chain-of-thought, retrieval vazio e escalação ' +
    'precoce para humano.';
  readonly schedule = '*/5 * * * *';

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.Database) private readonly db: Database,
    @inject(TYPES.Notifier) private readonly notifier: Notifier,
    @inject(TYPES.AlertsRepository) private readonly alertsRepo: AlertsRepository,
  ) {
    super();
  }

  async run(): Promise<void> {
    const log = this.logger.child({ job: this.name });
    const t0 = Date.now();
    let novos = 0;
    let expirados = 0;

    novos += await this.checkCotLeak(log);
    novos += await this.checkZeroChunks(log);
    novos += await this.checkEarlyEscalation(log);

    expirados += await this.expireOld(log, 'ai_rag_cot_leak');
    expirados += await this.expireOld(log, 'ai_rag_zero_chunks');
    expirados += await this.expireOld(log, 'ai_rag_early_human_escalation');

    const ms = Date.now() - t0;
    log.info(`Concluída em ${formatDuration(ms)} — ${novos} novo(s), ${expirados} expirado(s)`);
  }

  /** Procura padrões de chain-of-thought na response do callback http_call. */
  private async checkCotLeak(log: Logger): Promise<number> {
    const ilikeClauses = COT_PATTERNS.map((_p, i) => `r.response ILIKE $${i + 2}`).join(' OR ');

    const sql = `
      WITH recent AS (
        SELECT
          we.id AS execution_id,
          we.tenant_id,
          wd.slug,
          esl.input->'body'->>'response' AS response,
          esl.started_at
        FROM execution_step_logs esl
        JOIN workflow_executions we ON we.id = esl.workflow_execution_id
        JOIN workflow_definitions wd ON wd.id = we.workflow_definition_id
        WHERE wd.slug = ANY($1::text[])
          AND esl.step_type = 'http_call'
          AND esl.started_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
          AND esl.input->'body'->>'response' IS NOT NULL
      )
      SELECT
        r.execution_id::text,
        r.tenant_id,
        r.slug,
        r.response,
        r.started_at::text,
        (CASE
          ${COT_PATTERNS.map((_p, i) => `WHEN r.response ILIKE $${i + 2} THEN $${i + 2 + COT_PATTERNS.length}`).join('\n          ')}
        END) AS matched_phrase
      FROM recent r
      WHERE ${ilikeClauses}
      ORDER BY r.started_at DESC
      LIMIT 50
    `;

    const params: unknown[] = [TRACKED_SLUGS];
    for (const p of COT_PATTERNS) params.push(`%${p}%`);
    for (const p of COT_PATTERNS) params.push(p);

    const rows = await this.db.query<CotRow>(sql, params, 'workflow_processor');
    if (rows.length === 0) {
      log.debug({ check: 'cot_leak' }, 'sem detecções');
      return 0;
    }

    let novos = 0;
    for (const row of rows) {
      const fingerprint = `ai-rag-cot-leak::${row.execution_id}`;
      const created = await this.alertsRepo.insertOpen({
        typeCode: 'ai_rag_cot_leak',
        tenantId: row.tenant_id,
        fingerprint,
        payload: {
          execution_id: row.execution_id,
          slug: row.slug,
          matched_phrase: row.matched_phrase,
          response_snippet: row.response.slice(0, 500),
          started_at: row.started_at,
        },
      });

      if (created) {
        novos++;
        log.warn(
          `🚨 CoT leak detectado em ${row.slug} execution=${row.execution_id.slice(0, 8)} match="${row.matched_phrase}"`,
        );
        await this.notifier.googleChat(this.formatCotMessage(row));
      }
    }
    return novos;
  }

  /** Procura execuções onde o knowledge_base step não recuperou nenhum chunk. */
  private async checkZeroChunks(log: Logger): Promise<number> {
    const sql = `
      SELECT
        we.id::text AS execution_id,
        we.tenant_id,
        wd.slug,
        COALESCE(esl.input->>'query', we.input->>'message', '') AS query,
        esl.started_at::text
      FROM execution_step_logs esl
      JOIN workflow_executions we ON we.id = esl.workflow_execution_id
      JOIN workflow_definitions wd ON wd.id = we.workflow_definition_id
      WHERE wd.slug = ANY($1::text[])
        AND esl.step_type = 'knowledge_base'
        AND esl.status = 'completed'
        AND esl.started_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
        AND COALESCE((esl.metadata->>'chunks_retrieved')::int, 0) = 0
      ORDER BY esl.started_at DESC
      LIMIT 50
    `;

    const rows = await this.db.query<ZeroChunksRow>(sql, [TRACKED_SLUGS], 'workflow_processor');
    if (rows.length === 0) {
      log.debug({ check: 'zero_chunks' }, 'sem detecções');
      return 0;
    }

    let novos = 0;
    for (const row of rows) {
      const fingerprint = `ai-rag-zero-chunks::${row.execution_id}`;
      const created = await this.alertsRepo.insertOpen({
        typeCode: 'ai_rag_zero_chunks',
        tenantId: row.tenant_id,
        fingerprint,
        payload: {
          execution_id: row.execution_id,
          slug: row.slug,
          query: row.query.slice(0, 300),
          started_at: row.started_at,
        },
      });

      if (created) {
        novos++;
        log.warn(
          `⚠️  Zero chunks em ${row.slug} execution=${row.execution_id.slice(0, 8)} query="${row.query.slice(0, 60)}..."`,
        );
        await this.notifier.googleChat(this.formatZeroChunksMessage(row));
      }
    }
    return novos;
  }

  /** Procura execuções onde request_human_intervention foi chamada no primeiro turno. */
  private async checkEarlyEscalation(log: Logger): Promise<number> {
    const sql = `
      SELECT
        we.id::text AS execution_id,
        we.tenant_id,
        wd.slug,
        we.input->>'message' AS user_message,
        esl.started_at::text
      FROM execution_step_logs esl
      JOIN workflow_executions we ON we.id = esl.workflow_execution_id
      JOIN workflow_definitions wd ON wd.id = we.workflow_definition_id
      WHERE wd.slug = ANY($1::text[])
        AND esl.step_type = 'knowledge_base'
        AND esl.started_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
        AND COALESCE(we.input->>'conversationHistory', '') = ''
        AND esl.metadata @> '{"tool_calls":[{"tool":"request_human_intervention"}]}'::jsonb
      ORDER BY esl.started_at DESC
      LIMIT 50
    `;

    const rows = await this.db.query<EarlyEscalationRow>(
      sql,
      [TRACKED_SLUGS],
      'workflow_processor',
    );
    if (rows.length === 0) {
      log.debug({ check: 'early_escalation' }, 'sem detecções');
      return 0;
    }

    let novos = 0;
    for (const row of rows) {
      const fingerprint = `ai-rag-early-esc::${row.execution_id}`;
      const created = await this.alertsRepo.insertOpen({
        typeCode: 'ai_rag_early_human_escalation',
        tenantId: row.tenant_id,
        fingerprint,
        payload: {
          execution_id: row.execution_id,
          slug: row.slug,
          user_message: (row.user_message || '').slice(0, 300),
          started_at: row.started_at,
        },
      });

      if (created) {
        novos++;
        log.warn(
          `⚠️  Escalação precoce em ${row.slug} execution=${row.execution_id.slice(0, 8)} msg="${(row.user_message || '').slice(0, 60)}..."`,
        );
        await this.notifier.googleChat(this.formatEarlyEscalationMessage(row));
      }
    }
    return novos;
  }

  private async expireOld(log: Logger, code: AlertTypeCode): Promise<number> {
    const open = await this.alertsRepo.listOpenByType(code);
    if (open.length === 0) return 0;

    const cutoffMs = EXPIRY_HOURS * 3600 * 1000;
    let expired = 0;
    for (const alert of open) {
      const ageMs = Date.now() - new Date(alert.notifiedAt).getTime();
      if (ageMs < cutoffMs) continue;
      await this.alertsRepo.markResolved(alert.id, {
        byStatusCode: 'expired',
        note: `Auto-expired após ${EXPIRY_HOURS}h sem ação manual`,
        evidence: { age_ms: ageMs },
      });
      expired++;
      log.info(`⏰ Alert #${alert.id} (${code}) expirado`);
    }
    return expired;
  }

  private formatCotMessage(row: CotRow): string {
    return (
      `🚨 *RAG quality — CoT leak detectado*\n` +
      `*Workflow:* \`${row.slug}\`\n` +
      `*Tenant:* \`${row.tenant_id}\`\n` +
      `*Execution:* \`${row.execution_id}\`\n` +
      `*Frase capturada:* "${row.matched_phrase}"\n\n` +
      `*Resposta enviada ao cliente:*\n\`\`\`\n${row.response.slice(0, 800)}\n\`\`\`\n\n` +
      `IA expôs raciocínio interno na resposta. Verificar prompt enxuto e considerar reforçar regra anti-CoT ou ` +
      `migrar pra response_format=json com schema { message }. ` +
      `Ref: project_sunomono_cot_leak_2026_06_03.`
    );
  }

  private formatZeroChunksMessage(row: ZeroChunksRow): string {
    return (
      `⚠️ *RAG quality — zero chunks retrieved*\n` +
      `*Workflow:* \`${row.slug}\`\n` +
      `*Tenant:* \`${row.tenant_id}\`\n` +
      `*Execution:* \`${row.execution_id}\`\n` +
      `*Query:* "${row.query.slice(0, 200)}"\n\n` +
      `KB não devolveu nenhum chunk. Modelo respondeu sem contexto — risco de invenção. ` +
      `Verificar: similarity_threshold, top_k, e se a pergunta deveria ser coberta pela KB. ` +
      `Se for caso fora do escopo, considerar incluir um chunk de orientação genérica.`
    );
  }

  private formatEarlyEscalationMessage(row: EarlyEscalationRow): string {
    return (
      `⚠️ *RAG quality — escalação precoce p/ humano*\n` +
      `*Workflow:* \`${row.slug}\`\n` +
      `*Tenant:* \`${row.tenant_id}\`\n` +
      `*Execution:* \`${row.execution_id}\`\n` +
      `*Mensagem do cliente (1º turno):* "${row.user_message.slice(0, 200)}"\n\n` +
      `IA chamou request_human_intervention sem histórico — escalando cedo demais. ` +
      `Verificar se o prompt enxuto está orientando escalação prematura ou se a KB não cobre essa pergunta.`
    );
  }
}
