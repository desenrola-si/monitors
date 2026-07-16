import { injectable, inject } from 'inversify';
import { Job } from '../lib/job.js';
import { TYPES } from '../lib/types.js';
import { Logger } from '../lib/logger.js';
import { Database } from '../lib/database.js';
import { Notifier } from '../lib/notifier.js';
import { AlertsRepository } from '../lib/repositories/alerts-repository.js';
import { chatJson } from './daily-reports/llm.js';

// Sinais de ALTA confiança de que a resposta pode conter raciocínio vazado
// ou estar em inglês. Pré-filtro barato (Postgres ~*, POSIX) que reduz o
// volume ANTES de gastar LLM — o classificador confirma cada candidato.
// Escolha consciente: pré-filtro pode deixar passar vazamento atípico
// (subcontagem), em troca de custo baixo. Grupos:
//  1. tags de reasoning explícitas (<think>);
//  2. marcadores de raciocínio em inglês;
//  3. marcadores de raciocínio em português (o padrão do incidente Sunomono);
//  4. palavras funcionais de inglês que praticamente não aparecem em pt-BR.
export const COT_LEAK_SIGNAL_REGEX =
  '<think|</think|' +
  '\\y(let me|i need to|i should|i will|i must|first,? i|the user|the customer|as an ai|okay,? so|i have to|we need to|analy[sz]ing)\\y|' +
  '\\y(vou seguir o fluxo|a regra diz|preciso verificar o fluxo|analisando a|o cliente (enviou|disse|escreveu)|deixe-me pensar|seguindo rigorosamente|conforme o fluxo)\\y|' +
  '\\y(the|you|your|please|thank you|we are|i am|it is|there is|hello|sorry for)\\y';

const LOOKBACK_MINUTES = 70; // > intervalo (hourly) p/ margem de sobreposição
const CANDIDATE_LIMIT = 300; // teto de candidatos lidos por tick
const CLASSIFY_LIMIT = 100; // teto de chamadas LLM por tick (proteção de custo)
const MIN_MESSAGE_LEN = 15; // ignora acks curtos ("ok!", "👍")
const MESSAGE_MAX_CHARS = 2000; // trunca o texto enviado ao classificador
const EXPIRY_DAYS = 7;

interface CandidateRow {
  message_id: string;
  tenant_id: string;
  tenant_name: string;
  request_id: string;
  created_utc: string;
  created_brt: string;
  message: string;
}

interface LeakClassification {
  is_cot_leak: boolean;
  language: 'pt' | 'en' | 'mixed' | 'other';
  severity: 'low' | 'high';
  reason: string;
}

interface LeakPayload extends Record<string, unknown> {
  message_id: string;
  tenant_id: string;
  tenant_name: string;
  request_id: string;
  created_utc: string;
  created_brt: string;
  preview: string;
  classification: LeakClassification;
}

export const CLASSIFIER_SYSTEM_PROMPT = [
  'Você audita mensagens que uma IA de atendimento enviou a clientes finais',
  'via WhatsApp/Instagram. Detecte dois problemas:',
  '(1) VAZAMENTO DE RACIOCÍNIO (chain-of-thought): a mensagem revela o',
  'pensamento/análise interna da IA em vez de (ou além de) a resposta ao',
  'cliente — ex.: "O cliente enviou X, preciso verificar o fluxo Y, a regra',
  'diz...", "Let me check...", "I should...", tags <think>. Uma resposta',
  'normal ao cliente NÃO explica o próprio processo de decisão.',
  '(2) IDIOMA: a mensagem, no todo ou em parte relevante, não está em',
  'português do Brasil.',
  'Responda SOMENTE um JSON: {"is_cot_leak": boolean, "language":',
  '"pt"|"en"|"mixed"|"other", "severity": "low"|"high", "reason": string}.',
  'reason em português, 1 frase. Anglicismos comuns (delivery, app, link,',
  'voucher, combo) NÃO tornam o idioma "en"; classifique pelo texto geral.',
].join(' ');

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}min ${sec}s`;
}

/**
 * Monitor: IA vazando raciocínio interno (CoT) ou respondendo fora do pt-BR.
 *
 * Contexto: reincidência 16/07/2026 (Moovery/Bruum) do incidente Sunomono
 * (03/06). O modelo escreve o pensamento dentro da resposta final e ele sai
 * em inglês. Fix no workflow-processor (PR#117, enforceOutputPolicy) injeta
 * guard anti-CoT + pt-BR — guard por prompt reduz muito mas não é 100%.
 * Este monitor mede o resíduo em produção e alerta em regressão.
 *
 * Fluxo (a cada hora):
 *  1. Lê respostas da IA (message_logs origin='agent') dos últimos ~70min,
 *     de TODOS os tenants, pré-filtradas por regex de sinais de CoT/inglês.
 *  2. Classifica cada candidato via LLM (DeepSeek, temperatura 0) →
 *     {is_cot_leak, language, severity, reason}.
 *  3. Confirma quando is_cot_leak OU language != 'pt'; grava alerta
 *     idempotente por message_id + notifica Google Chat.
 *  4. Auto-expira alertas após 7 dias sem ação.
 */
@injectable()
export class AiResponseCotLeakJob extends Job {
  readonly name = 'ai-response-cot-leak-monitor';
  readonly displayName = 'IA vazando raciocínio / respondendo em inglês';
  readonly description =
    'Detecta respostas da IA ao cliente que vazam raciocínio interno ' +
    '(chain-of-thought) ou que não estão em português. Pré-filtra por regex ' +
    'e confirma com LLM. Regressão do guard anti-CoT/idioma (PR#117).';
  readonly schedule = '7 * * * *';

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.Database) private readonly db: Database,
    @inject(TYPES.Notifier) private readonly notifier: Notifier,
    @inject(TYPES.AlertsRepository)
    private readonly alertsRepo: AlertsRepository,
  ) {
    super();
  }

  async run(): Promise<void> {
    const log = this.logger.child({ job: this.name });
    const t0 = Date.now();
    log.info('Procurando respostas da IA com CoT vazado / fora do pt-BR');

    const created = await this.detectNew(log);
    const expired = await this.expireOld(log);

    const ms = Date.now() - t0;
    log.info(
      `Concluída em ${formatDuration(ms)} — ${created} novo(s), ${expired} expirado(s)`,
    );
  }

  private async detectNew(log: Logger): Promise<number> {
    const candidates = await this.db.query<CandidateRow>(
      `
      SELECT
        m.id::text AS message_id,
        m.tenant_id::text AS tenant_id,
        COALESCE(t.name, '(sem nome)') AS tenant_name,
        m.request_id,
        TO_CHAR(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_utc,
        TO_CHAR((m.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI:SS') AS created_brt,
        LEFT(m.message, $4) AS message
      FROM message_logs m
      LEFT JOIN tenants t ON t.id = m.tenant_id
      WHERE m.origin = 'agent'
        AND m.created_at >= NOW() - make_interval(mins => $1)
        AND m.message IS NOT NULL
        AND length(m.message) >= $2
        AND m.message ~* $3
      ORDER BY m.created_at DESC
      LIMIT $5
      `,
      [
        LOOKBACK_MINUTES,
        MIN_MESSAGE_LEN,
        COT_LEAK_SIGNAL_REGEX,
        MESSAGE_MAX_CHARS,
        CANDIDATE_LIMIT,
      ],
    );

    if (candidates.length === 0) {
      log.info(`Nenhum candidato nos últimos ${LOOKBACK_MINUTES}min`);
      return 0;
    }

    const toClassify = candidates.slice(0, CLASSIFY_LIMIT);
    if (candidates.length > CLASSIFY_LIMIT) {
      log.warn(
        `${candidates.length} candidatos — classificando só os ${CLASSIFY_LIMIT} mais recentes (teto de custo); ${candidates.length - CLASSIFY_LIMIT} não avaliados neste tick`,
      );
    } else {
      log.info(`${candidates.length} candidato(s) pré-filtrado(s) para classificação`);
    }

    let novosNoTick = 0;
    let confirmados = 0;
    for (const row of toClassify) {
      const classification = await this.classify(row, log);
      if (!classification) continue;
      const isProblem =
        classification.is_cot_leak || classification.language !== 'pt';
      if (!isProblem) continue;
      confirmados++;

      const fingerprint = `cot-leak::${row.tenant_id}::${row.message_id}`;
      const preview = row.message.slice(0, 400);
      const payload: LeakPayload = {
        message_id: row.message_id,
        tenant_id: row.tenant_id,
        tenant_name: row.tenant_name,
        request_id: row.request_id,
        created_utc: row.created_utc,
        created_brt: row.created_brt,
        preview,
        classification,
      };

      const created = await this.alertsRepo.insertOpen({
        typeCode: 'ai_response_cot_leak',
        tenantId: row.tenant_id,
        requestId: row.request_id,
        fingerprint,
        payload,
      });

      if (created) {
        novosNoTick++;
        log.warn(
          `🚨 CoT/idioma #${created.id} ${row.tenant_name} msg=${row.message_id} lang=${classification.language} leak=${classification.is_cot_leak}`,
        );
        await this.notifier.googleChat(this.formatNewAlertMessage(row, classification));
      } else {
        log.debug(`msg ${row.message_id} já tinha alerta aberto`);
      }
    }

    log.info(
      `${confirmados} confirmado(s) de ${toClassify.length} classificado(s); ${novosNoTick} alerta(s) novo(s)`,
    );
    return novosNoTick;
  }

  private async classify(
    row: CandidateRow,
    log: Logger,
  ): Promise<LeakClassification | null> {
    try {
      const { data } = await chatJson<LeakClassification>({
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        userPrompt: `Mensagem enviada pela IA ao cliente:\n"""\n${row.message}\n"""`,
      });
      return data;
    } catch (err) {
      log.error(
        `Falha ao classificar msg ${row.message_id}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async expireOld(log: Logger): Promise<number> {
    const open = await this.alertsRepo.listOpenByType('ai_response_cot_leak');
    if (open.length === 0) return 0;

    const cutoffMs = EXPIRY_DAYS * 24 * 3600 * 1000;
    let expired = 0;
    for (const alert of open) {
      const ageMs = Date.now() - new Date(alert.notifiedAt).getTime();
      if (ageMs < cutoffMs) continue;
      await this.alertsRepo.markResolved(alert.id, {
        byStatusCode: 'expired',
        note: `Auto-expirado após ${EXPIRY_DAYS} dias sem ação manual`,
        evidence: { age_ms: ageMs },
      });
      expired++;
      log.info(`⏰ Alerta #${alert.id} expirado`);
    }
    return expired;
  }

  private formatNewAlertMessage(
    row: CandidateRow,
    c: LeakClassification,
  ): string {
    const emoji = c.severity === 'high' ? '🔴' : '🟡';
    const problema = c.is_cot_leak
      ? 'vazou raciocínio interno (CoT)'
      : `respondeu em idioma "${c.language}"`;
    const link = `https://app.desenrolasi.com.br/conversas/${row.request_id}?tenantId=${row.tenant_id}`;
    return (
      `${emoji} *IA ${problema}*\n` +
      `*Tenant:* ${row.tenant_name} \`${row.tenant_id}\`\n` +
      `*Conversa:* ${row.request_id}\n` +
      `*Quando:* ${row.created_brt} BRT\n` +
      `*Idioma:* ${c.language} · *CoT:* ${c.is_cot_leak ? 'sim' : 'não'}\n` +
      `*Motivo:* ${c.reason}\n` +
      `*Mensagem da IA:*\n${row.message.slice(0, 400)}\n\n` +
      `⚠️ Regressão do guard anti-CoT/idioma (PR#117 workflow-processor). ` +
      `Verificar o prompt/step do workflow desse tenant.\n\n` +
      `Conversa: ${link}`
    );
  }
}
