import { injectable, inject } from 'inversify';
import { Job } from '../lib/job.js';
import { TYPES } from '../lib/types.js';
import { Logger } from '../lib/logger.js';
import { Database } from '../lib/database.js';
import { Notifier } from '../lib/notifier.js';
import { AlertsRepository } from '../lib/repositories/alerts-repository.js';

const ALERT_TYPE = 'anthrotech_date_bruteforce';
const EXPIRY_DAYS = 7;
const LOOKBACK_HOURS = 6;
const CREATE_TOOL_PREFIX = 'create_anthrotech_';

interface CandidateRow {
  execution_id: string;
  tenant_id: string;
  requester_id: string | null;
  at_brt: string;
  preview: string;
  tool_calls: ToolCall[];
}

interface ToolCall {
  tool?: string;
  args?: { data?: string } | null;
  result?: { success?: boolean; error?: unknown; data?: { codigo?: string } } | null;
  error?: unknown;
}

interface Bruteforce {
  triedDates: string[];
  bookedDate: string | null;
  bookedCodigo: string | null;
}

interface BruteforcePayload extends Record<string, unknown> {
  execution_id: string;
  at_brt: string;
  tried_dates: string[];
  booked_date: string | null;
  booked_codigo: string | null;
  preview: string;
  phone_formatted: string;
}

function formatPhone(raw: string | null): string {
  if (!raw) return '—';
  if (raw.length === 13 && raw.startsWith('55')) {
    return `(${raw.slice(2, 4)}) ${raw.slice(4, 5)} ${raw.slice(5, 9)}-${raw.slice(9)}`;
  }
  return raw;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}min ${sec}s`;
}

function isSuccess(tc: ToolCall): boolean {
  if (tc.error != null) return false;
  const r = tc.result;
  if (r == null || typeof r !== 'object') return false;
  if ((r as { error?: unknown }).error != null) return false;
  return r.success === true || r.data?.codigo != null;
}

/**
 * Monitor: a IA tentou VÁRIAS datas de agendamento no mesmo turno e
 * agendou uma — à revelia do cliente.
 *
 * Contexto: incidente Carolina OS39820B (01/06/2026). A descrição da tool
 * de reinspeção mandava chamar a API direto e, no 400, "sugerir outra" —
 * a IA iterava datas (05/06, 06/06, 08/06, 09/06) e agendava a 1ª que a
 * API aceitasse, confirmando data que a cliente não escolheu.
 *
 * Sinal observável e auto-contido: num único step `process-ai`, ≥2
 * `create_anthrotech_*` com DATAS DISTINTAS e pelo menos uma com sucesso.
 * Pós-hotfix (09/06/2026) isso configura regressão do prompt/tool.
 *
 * Fluxo (cada 10min):
 *  1. Busca steps process-ai (workflow_processor) nas últimas 6h com ≥2
 *     create_anthrotech_* nos tool_calls.
 *  2. Filtra os que têm ≥2 datas distintas tentadas + uma agendada.
 *  3. Fingerprint por execution_id (1 alerta por turno ofensivo).
 *  4. Auto-expire em 7 dias se ninguém atuou.
 */
@injectable()
export class AnthrotechDateBruteforceJob extends Job {
  readonly name = 'anthrotech-date-bruteforce-monitor';
  readonly displayName = 'Brute-force de datas no agendamento (Anthrotech)';
  readonly description =
    'Avisa quando a IA tentou várias datas no mesmo turno e agendou uma ' +
    'sem o cliente escolher. Pós-hotfix de 09/06/2026 isso configura ' +
    'regressão da descrição da tool ou do system_prompt.';
  readonly schedule = '*/10 * * * *';

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
    log.info('Procurando brute-force de datas no agendamento');

    const created = await this.detectNew(log);
    const expired = await this.expireOld(log);

    const ms = Date.now() - t0;
    const novos =
      created === 0 ? 'nenhum brute-force novo' : `${created} brute-force novo(s)`;
    const finalizados =
      expired === 0 ? 'nenhum expirado' : `${expired} expirado(s)`;
    log.info(
      `Checagem concluída em ${formatDuration(ms)} — ${novos}, ${finalizados}`,
    );
  }

  private async detectNew(log: Logger): Promise<number> {
    const sinceUtc = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000);

    const candidates = await this.db.query<CandidateRow>(
      `
      SELECT
        we.id::text AS execution_id,
        we.tenant_id,
        we.input->>'requesterId' AS requester_id,
        TO_CHAR((we.started_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS at_brt,
        LEFT(esl.output->>'content', 300) AS preview,
        esl.metadata->'tool_calls' AS tool_calls
      FROM execution_step_logs esl
      JOIN workflow_executions we ON we.id = esl.workflow_execution_id
      WHERE esl.step_id = 'process-ai'
        AND we.started_at >= $1::timestamptz
        AND (
          SELECT COUNT(*)
          FROM jsonb_array_elements(esl.metadata->'tool_calls') tc
          WHERE tc->>'tool' LIKE '${CREATE_TOOL_PREFIX}%'
        ) >= 2
      ORDER BY we.started_at DESC
      `,
      [sinceUtc.toISOString()],
      'workflow_processor',
    );

    if (candidates.length === 0) {
      log.info(`Nenhum turno com ≥2 create nas últimas ${LOOKBACK_HOURS}h`);
      return 0;
    }

    let novosNoTick = 0;
    for (const row of candidates) {
      const bf = this.analyze(row.tool_calls);
      if (!bf) continue;

      const phone = formatPhone(row.requester_id);
      const fingerprint = `date-bruteforce::${row.tenant_id}::${row.execution_id}`;
      const payload: BruteforcePayload = {
        execution_id: row.execution_id,
        at_brt: row.at_brt,
        tried_dates: bf.triedDates,
        booked_date: bf.bookedDate,
        booked_codigo: bf.bookedCodigo,
        preview: row.preview,
        phone_formatted: phone,
      };

      const created = await this.alertsRepo.insertOpen({
        typeCode: ALERT_TYPE,
        tenantId: row.tenant_id,
        requestId: row.requester_id ?? row.execution_id,
        fingerprint,
        payload,
      });

      if (created) {
        novosNoTick++;
        log.warn(
          `🚨 Brute-force #${created.id} — ${phone} tentou ${bf.triedDates.length} datas, agendou ${bf.bookedDate}`,
        );
        await this.notifier.googleChat(this.formatNewAlertMessage(row, bf));
      } else {
        log.debug(`exec ${row.execution_id} já tinha alerta aberto`);
      }
    }

    return novosNoTick;
  }

  /**
   * Retorna o brute-force quando o turno tentou ≥2 datas DISTINTAS de
   * create e ao menos uma teve sucesso. Datas iguais (retry do mesmo dia
   * após erro transitório) NÃO contam.
   */
  private analyze(toolCalls: ToolCall[] | null): Bruteforce | null {
    if (!Array.isArray(toolCalls)) return null;

    const creates = toolCalls.filter(
      (tc) => typeof tc.tool === 'string' && tc.tool.startsWith(CREATE_TOOL_PREFIX),
    );
    if (creates.length < 2) return null;

    const triedDates = [
      ...new Set(
        creates
          .map((tc) => tc.args?.data)
          .filter((d): d is string => typeof d === 'string' && d.length > 0),
      ),
    ];
    if (triedDates.length < 2) return null;

    const booked = creates.find(isSuccess);
    if (!booked) return null;

    return {
      triedDates,
      bookedDate: booked.args?.data ?? null,
      bookedCodigo: booked.result?.data?.codigo ?? null,
    };
  }

  private async expireOld(log: Logger): Promise<number> {
    const open = await this.alertsRepo.listOpenByType(ALERT_TYPE);
    if (open.length === 0) return 0;

    const cutoffMs = EXPIRY_DAYS * 24 * 3600 * 1000;
    let expired = 0;
    for (const alert of open) {
      const ageMs = Date.now() - new Date(alert.notifiedAt).getTime();
      if (ageMs < cutoffMs) continue;
      await this.alertsRepo.markResolved(alert.id, {
        byStatusCode: 'expired',
        note: `Auto-expired após ${EXPIRY_DAYS} dias sem ação manual`,
        evidence: { age_ms: ageMs },
      });
      expired++;
      log.info(`⏰ Alerta #${alert.id} expirado (${EXPIRY_DAYS}d)`);
    }
    return expired;
  }

  private formatNewAlertMessage(row: CandidateRow, bf: Bruteforce): string {
    const phone = formatPhone(row.requester_id);
    const tried = bf.triedDates.join(', ');
    return (
      `🚨 *Amilgás — IA tentou várias datas e agendou sem o cliente escolher*\n` +
      `*Cliente:* ${phone}\n` +
      `*Quando:* ${row.at_brt} BRT\n` +
      `*Datas tentadas:* ${tried}\n` +
      `*Agendou:* ${bf.bookedDate ?? '—'}${bf.bookedCodigo ? ` (${bf.bookedCodigo})` : ''}\n` +
      `*Mensagem da IA:*\n${row.preview.slice(0, 300)}\n\n` +
      `*Diagnóstico:* ⚠️ A IA fez ${bf.triedDates.length} tentativas de create em datas ` +
      `distintas no mesmo turno e confirmou uma — provável data que o cliente não pediu. ` +
      `Verificar e contatar o cliente.\n\n` +
      `Ver conversa: https://app.desenrolasi.com.br/conversas/${row.requester_id ?? ''}?tenantId=${row.tenant_id}`
    );
  }
}
