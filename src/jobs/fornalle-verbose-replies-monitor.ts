import { injectable, inject } from 'inversify';
import { Job } from '../lib/job.js';
import { TYPES } from '../lib/types.js';
import { Logger } from '../lib/logger.js';
import { Database } from '../lib/database.js';
import { Notifier } from '../lib/notifier.js';
import { AlertsRepository } from '../lib/repositories/alerts-repository.js';

/** Tenant da Fornalle (slug `fornalle`). */
const FORNALLE_TENANT_ID = 'cmbo4zqb10000mcdpjjkgjllt';

/**
 * Janela analisada a cada tick. 48h porque o volume da Fornalle é ~15
 * respostas simples/dia — uma janela de 24h fica abaixo de MIN_SAMPLE na
 * maioria dos dias e o monitor pularia. 48h dá amostra ~30, estável.
 */
const WINDOW_HOURS = 48;

/**
 * Teto de caracteres de uma resposta "simples". Alinhado à regra inserida no
 * system_prompt do fornalle-validation-wf ("Respostas com mais de 350
 * caracteres" — exceto resumo de reserva).
 */
const VERBOSE_CHAR_CEIL = 350;

/** Amostra mínima de respostas simples na janela pra o número ter significado. */
const MIN_SAMPLE = 20;

/**
 * Gatilho: fatia de respostas simples acima do teto. Baseline pós-fix ~11%,
 * pré-fix ~29%. 25% indica regressão clara em direção ao estado pré-fix sem
 * disparar pelo ruído natural do pós-fix.
 */
const VERBOSE_SHARE_PCT_THRESHOLD = 25;

/** Auto-resolve o alerta após esse tempo sem ação — um dia ruim isolado limpa. */
const EXPIRY_HOURS = 48;

interface VerbosityRow {
  total: number;
  verbose: number;
  verbose_share_pct: number;
  avg_len: number;
  median_len: number;
  p90_len: number;
  window_start: string;
  window_end: string;
}

interface VerbosityPayload extends Record<string, unknown> {
  tenant_id: string;
  window_hours: number;
  char_ceil: number;
  total_plain_replies: number;
  verbose_replies: number;
  verbose_share_pct: number;
  avg_len: number;
  median_len: number;
  p90_len: number;
  threshold_pct: number;
  window_start: string;
  window_end: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}min ${sec}s`;
}

/**
 * Monitor: respostas prolixas do agente da Fornalle (Bartô).
 *
 * Contexto: ClickUp 86e20kakk (24/06/2026) — "IA dando respostas longas pra
 * perguntas simples". O fix inseriu o "PRINCÍPIO 0 — CONCISÃO" no system_prompt
 * do fornalle-validation-wf e baixou o teto de 1000 → 350 caracteres.
 *
 * Detecção: sobre as respostas do agente (origin 'agent') nas últimas
 * WINDOW_HOURS, exclui os resumos de reserva (longos por natureza) e mede a
 * fatia que passa de VERBOSE_CHAR_CEIL. Se a fatia >= VERBOSE_SHARE_PCT_THRESHOLD
 * com amostra suficiente, alerta — a concisão regrediu (prompt sobrescrito num
 * deploy/edição ou modelo voltou a ser prolixo).
 *
 * Fingerprint por tenant + dia (UTC): no máximo um alerta por dia.
 */
@injectable()
export class FornalleVerboseRepliesMonitorJob extends Job {
  readonly name = 'fornalle-verbose-replies-monitor';
  readonly displayName = 'Respostas prolixas da Fornalle (Bartô)';
  readonly description =
    'Detecta regressão de concisão no agente da Fornalle: fatia de respostas ' +
    'simples acima do teto de caracteres voltando aos níveis pré-fix (ClickUp ' +
    '86e20kakk). Sinal de prompt sobrescrito ou modelo voltando a ser prolixo.';
  readonly schedule = '0 11 * * *';

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
    log.info('Medindo concisão das respostas da Fornalle');

    const created = await this.detect(log);
    const expired = await this.expireOld(log);

    const ms = Date.now() - t0;
    log.info(
      `Concluída em ${formatDuration(ms)} — ${created} novo(s), ${expired} expirado(s)`,
    );
  }

  private async detect(log: Logger): Promise<number> {
    const rows = await this.db.query<VerbosityRow>(
      `
      WITH plain AS (
        SELECT length(message) AS len
        FROM message_logs
        WHERE tenant_id = $1
          AND origin = 'agent'
          AND length(trim(message)) > 0
          AND created_at >= NOW() - make_interval(hours => $2)
          AND message !~* '(RESUMO DA RESERVA|Reserva (confirmada|atualizada|cancelada))'
      )
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE len > $3)::int AS verbose,
        COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE len > $3) / NULLIF(COUNT(*), 0)), 0)::int AS verbose_share_pct,
        COALESCE(ROUND(AVG(len)), 0)::int AS avg_len,
        COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY len), 0)::int AS median_len,
        COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY len), 0)::int AS p90_len,
        TO_CHAR(NOW() - make_interval(hours => $2), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS window_start,
        TO_CHAR(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS window_end
      FROM plain
      `,
      [FORNALLE_TENANT_ID, WINDOW_HOURS, VERBOSE_CHAR_CEIL],
    );

    const row = rows[0];
    if (!row || row.total < MIN_SAMPLE) {
      log.info(
        `Amostra insuficiente (${row?.total ?? 0} < ${MIN_SAMPLE}) — sem avaliação`,
      );
      return 0;
    }

    log.info(
      `${row.total} respostas simples — média ${row.avg_len}, mediana ${row.median_len}, ` +
        `${row.verbose_share_pct}% acima de ${VERBOSE_CHAR_CEIL} chars`,
    );

    if (row.verbose_share_pct < VERBOSE_SHARE_PCT_THRESHOLD) {
      return 0;
    }

    const day = row.window_end.slice(0, 10);
    const fingerprint = `fornalle-verbose::${FORNALLE_TENANT_ID}::${day}`;
    const payload: VerbosityPayload = {
      tenant_id: FORNALLE_TENANT_ID,
      window_hours: WINDOW_HOURS,
      char_ceil: VERBOSE_CHAR_CEIL,
      total_plain_replies: row.total,
      verbose_replies: row.verbose,
      verbose_share_pct: row.verbose_share_pct,
      avg_len: row.avg_len,
      median_len: row.median_len,
      p90_len: row.p90_len,
      threshold_pct: VERBOSE_SHARE_PCT_THRESHOLD,
      window_start: row.window_start,
      window_end: row.window_end,
    };

    const created = await this.alertsRepo.insertOpen({
      typeCode: 'fornalle_verbose_replies',
      tenantId: FORNALLE_TENANT_ID,
      fingerprint,
      payload,
    });

    if (!created) {
      return 0;
    }

    log.warn(
      `🚨 Regressão de concisão #${created.id} — ${row.verbose_share_pct}% acima de ${VERBOSE_CHAR_CEIL} (limite ${VERBOSE_SHARE_PCT_THRESHOLD}%)`,
    );
    await this.notifier.googleChat(this.formatMessage(row));
    return 1;
  }

  private async expireOld(log: Logger): Promise<number> {
    const open = await this.alertsRepo.listOpenByType('fornalle_verbose_replies');
    if (open.length === 0) return 0;

    const cutoffMs = EXPIRY_HOURS * 3600 * 1000;
    let expired = 0;
    for (const alert of open) {
      const ageMs = Date.now() - new Date(alert.notifiedAt).getTime();
      if (ageMs < cutoffMs) continue;
      await this.alertsRepo.markResolved(alert.id, {
        byStatusCode: 'expired',
        note: `Auto-expirado após ${EXPIRY_HOURS}h sem ação manual`,
        evidence: { age_ms: ageMs },
      });
      expired++;
      log.info(`⏰ Alerta de concisão #${alert.id} expirado`);
    }
    return expired;
  }

  private formatMessage(row: VerbosityRow): string {
    const emoji = row.verbose_share_pct >= 35 ? '🔴' : '🟡';
    return (
      `${emoji} *Respostas prolixas da Fornalle (Bartô)*\n` +
      `*Tenant:* \`${FORNALLE_TENANT_ID}\` (fornalle)\n` +
      `*Janela:* últimas ${WINDOW_HOURS}h — ${row.total} respostas simples\n` +
      `*Acima de ${VERBOSE_CHAR_CEIL} chars:* ${row.verbose_share_pct}% (${row.verbose}/${row.total}) — limite ${VERBOSE_SHARE_PCT_THRESHOLD}%\n` +
      `*Tamanho:* média ${row.avg_len} · mediana ${row.median_len} · p90 ${row.p90_len}\n\n` +
      `⚠️ A concisão regrediu aos níveis pré-fix (ClickUp 86e20kakk). ` +
      `Verificar se o "PRINCÍPIO 0 — CONCISÃO" ainda está no system_prompt do ` +
      `workflow fornalle-validation-wf (pode ter sido sobrescrito num deploy/edição).`
    );
  }
}
