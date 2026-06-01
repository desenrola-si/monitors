import { injectable, inject } from 'inversify';
import { Job } from '../lib/job.js';
import { TYPES } from '../lib/types.js';
import { Logger } from '../lib/logger.js';
import { Database } from '../lib/database.js';
import { Notifier } from '../lib/notifier.js';
import { AlertsRepository } from '../lib/repositories/alerts-repository.js';

const TENANT_ID = 'b14ddbae-1543-46b5-b3fa-e314c10c31b9'; // Amilgás
const TENANT_NAME = 'Amilgás';

// Padrão CLARO de IA confirmando criação de nova OS. Mantido restritivo de
// propósito pra evitar falso positivo (mensagens informativas / confirmação
// de cancelamento mencionando data). Quando a IA cria work_order via tool,
// ela sempre envia "Agendamento confirmado! ✅" — esse é o sinal forte.
const SCHEDULING_CONFIRMATION_REGEX =
  'agendamento\\s+confirmado|marcamos\\s+sua\\s+vistoria\\s+para';

// Exclusão: mensagens de cancelamento podem mencionar a data agendada
// ("OS39782 — agendada para amanhã ... foi cancelada"). Não são confirmação
// de NOVA criação. Excluir essas pra evitar ruído.
const CANCELLATION_EXCLUSION_REGEX =
  'cancelamento\\s+confirmado|cancelada\\s+com\\s+sucesso|antes\\s+de\\s+cancelar';

const EXPIRY_DAYS = 7;
const LOOKBACK_HOURS = 6;
const AVAILABILITY_WINDOW_HOURS = 24;

interface BypassRow {
  request_id: string;
  message_id: string;
  scheduled_msg_utc: string;
  scheduled_msg_brt: string;
  preview: string;
}

interface BypassPayload extends Record<string, unknown> {
  message_id: string;
  scheduled_msg_utc: string;
  scheduled_msg_brt: string;
  preview: string;
  phone_formatted: string;
}

function formatPhone(raw: string): string {
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

/**
 * Monitor: IA confirmou agendamento sem chamar get_anthrotech_availability.
 *
 * Contexto: incidente Maria Medeiros 30/05/2026. IA usava regra estática do
 * prompt ("sexta antes de 16:30 → sábado") sem consultar capacidade real.
 * Resultado: 18 clientes confirmaram pra sábado quando vagas já tinham
 * esgotado. Hotfix 01/06 forçou regra "OBRIGATÓRIO chamar
 * get_anthrotech_availability antes de propor data" + backend cruza
 * Anthrotech com validator local. Esse monitor garante o comportamento.
 *
 * Se aparecer alerta, é regressão (prompt ou enforcement).
 *
 * Fluxo (cada 10min):
 *  1. Detecta mensagens 'agent' nas últimas 6h com padrão de confirmação
 *     de agendamento + data específica
 *  2. Pra cada uma: verifica se houve tool_execution_logs de
 *     get_anthrotech_availability na MESMA conversa nas últimas 24h ANTES
 *     da mensagem da IA. Se não → alerta.
 *  3. Fingerprint por message_id (1 alerta por mensagem ofensiva).
 *  4. Auto-expire em 7 dias se ninguém atuou.
 */
@injectable()
export class AnthrotechAvailabilityBypassJob extends Job {
  readonly name = 'anthrotech-availability-bypass-monitor';
  readonly displayName = `Agendamento sem availability check — ${TENANT_NAME}`;
  readonly description =
    'Avisa quando a IA confirma data de agendamento sem ter chamado ' +
    'get_anthrotech_availability antes. Pós-hotfix de 01/06/2026 isso ' +
    'configura regressão do prompt ou bug do enforcement.';
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
    log.info('Procurando agendamentos da IA sem availability check');

    const created = await this.detectNew(log);
    const expired = await this.expireOld(log);

    const ms = Date.now() - t0;
    const novos =
      created === 0 ? 'nenhum bypass novo' : `${created} bypass novo(s)`;
    const finalizados =
      expired === 0 ? 'nenhum expirado' : `${expired} expirado(s)`;
    log.info(
      `Checagem concluída em ${formatDuration(ms)} — ${novos}, ${finalizados}`,
    );
  }

  private async detectNew(log: Logger): Promise<number> {
    const sinceUtc = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000);
    const availabilityLookbackUtc = new Date(
      Date.now() - (LOOKBACK_HOURS + AVAILABILITY_WINDOW_HOURS) * 3600 * 1000,
    );

    // 1) Mensagens candidatas no DB desenrola — IA confirmando agendamento
    const candidates = await this.db.query<BypassRow>(
      `
      SELECT
        m.request_id,
        m.id::text AS message_id,
        TO_CHAR(m.receivad_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS scheduled_msg_utc,
        TO_CHAR((m.receivad_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI:SS') AS scheduled_msg_brt,
        LEFT(m.message, 300) AS preview
      FROM message_logs m
      WHERE m.tenant_id = $1
        AND m.origin = 'agent'
        AND m.receivad_at >= $2::timestamp
        AND m.message ~* $3
        AND m.message !~* $4
      ORDER BY m.receivad_at DESC
      `,
      [
        TENANT_ID,
        sinceUtc.toISOString(),
        SCHEDULING_CONFIRMATION_REGEX,
        CANCELLATION_EXCLUSION_REGEX,
      ],
    );

    if (candidates.length === 0) {
      log.info(`Nenhuma confirmação de agendamento nas últimas ${LOOKBACK_HOURS}h`);
      return 0;
    }

    // 2) Pra cada candidata, verifica no workflow_processor se houve
    //    get_anthrotech_availability na conversa antes da mensagem
    const rows: BypassRow[] = [];
    for (const c of candidates) {
      const hadAvailability = await this.didCallAvailability(
        c.request_id,
        c.scheduled_msg_utc,
        availabilityLookbackUtc.toISOString(),
      );
      if (!hadAvailability) rows.push(c);
    }

    if (rows.length === 0) {
      log.info(
        `${candidates.length} confirmação(ões) checada(s) — todas chamaram availability, OK`,
      );
      return 0;
    }
    log.warn(
      `${rows.length}/${candidates.length} confirmação(ões) SEM availability check`,
    );

    let novosNoTick = 0;
    for (const row of rows) {
      const phone = formatPhone(row.request_id);
      const fingerprint = `availability-bypass::${TENANT_ID}::${row.message_id}`;
      const payload: BypassPayload = {
        message_id: row.message_id,
        scheduled_msg_utc: row.scheduled_msg_utc,
        scheduled_msg_brt: row.scheduled_msg_brt,
        preview: row.preview,
        phone_formatted: phone,
      };

      const created = await this.alertsRepo.insertOpen({
        typeCode: 'anthrotech_scheduled_without_availability_check',
        tenantId: TENANT_ID,
        requestId: row.request_id,
        fingerprint,
        payload,
      });

      if (created) {
        novosNoTick++;
        log.warn(
          `🚨 Bypass #${created.id} — ${phone} (${row.scheduled_msg_brt} BRT)`,
        );
        await this.notifier.googleChat(this.formatNewAlertMessage(row));
      } else {
        log.debug(`${phone}/msg ${row.message_id} já tinha alerta aberto`);
      }
    }

    return novosNoTick;
  }

  /**
   * Verifica no DB workflow_processor se a IA chamou
   * get_anthrotech_availability nessa conversa nas últimas N horas antes
   * da mensagem ofensiva. Tool calls ficam em
   * execution_step_logs.metadata.tool_calls (array JSON) — NÃO na
   * desenrola.tool_execution_logs (essa só guarda tools chamadas via
   * HTTP direta do backend, não as do agente).
   */
  private async didCallAvailability(
    requestId: string,
    scheduledMsgUtc: string,
    windowStartUtc: string,
  ): Promise<boolean> {
    const rows = await this.db.query<{ has_call: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1
        FROM execution_step_logs esl
        JOIN workflow_executions we ON we.id = esl.workflow_execution_id
        WHERE we.tenant_id = $1
          AND we.input->>'requesterId' = $2
          AND we.started_at >= $3::timestamptz
          AND we.started_at <= $4::timestamptz
          AND esl.step_id = 'process-ai'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(esl.metadata->'tool_calls') tc
            WHERE tc->>'tool' = 'get_anthrotech_availability'
          )
      ) AS has_call
      `,
      [TENANT_ID, requestId, windowStartUtc, scheduledMsgUtc],
      'workflow_processor',
    );
    return rows[0]?.has_call === true;
  }

  private async expireOld(log: Logger): Promise<number> {
    const open = await this.alertsRepo.listOpenByType(
      'anthrotech_scheduled_without_availability_check',
    );
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

  private formatNewAlertMessage(row: BypassRow): string {
    const phone = formatPhone(row.request_id);
    return (
      `🚨 *${TENANT_NAME} — IA confirmou agendamento sem checar disponibilidade*\n` +
      `*Cliente:* ${phone}\n` +
      `*Quando:* ${row.scheduled_msg_brt} BRT\n` +
      `*Mensagem da IA:*\n${row.preview.slice(0, 400)}\n\n` +
      `*Diagnóstico:* ⚠️ A IA confirmou data específica sem chamar ` +
      `\`get_anthrotech_availability\` nesta conversa. Pode ter agendado ` +
      `pra dia sem vaga. Verificar manualmente e contatar cliente se necessário.\n\n` +
      `Ver conversa: https://app.desenrolasi.com.br/conversas/${row.request_id}?tenantId=${TENANT_ID}`
    );
  }
}
