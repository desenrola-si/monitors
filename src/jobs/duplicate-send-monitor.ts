import { injectable, inject } from 'inversify';
import { Job } from '../lib/job.js';
import { TYPES } from '../lib/types.js';
import { Logger } from '../lib/logger.js';
import { Database } from '../lib/database.js';
import { Notifier } from '../lib/notifier.js';
import { AlertsRepository } from '../lib/repositories/alerts-repository.js';

const LOOKBACK_HOURS = 6;
const DUPLICATE_THRESHOLD = 3;
const WINDOW_SECONDS = 60;
const EXPIRY_HOURS = 24;

interface BurstRow {
  tenant_id: string;
  origin: string;
  origin_id: string;
  request_id: string;
  message_preview: string;
  dup_count: number;
  first_at: string;
  last_at: string;
  window_seconds: number;
}

interface BurstPayload extends Record<string, unknown> {
  tenant_id: string;
  origin: string;
  origin_id: string;
  request_id: string;
  dup_count: number;
  window_seconds: number;
  first_at: string;
  last_at: string;
  message_preview: string;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}min ${sec}s`;
}

/**
 * Monitor: mensagens de saída duplicadas em rajada.
 *
 * Contexto: incidente Moovery (15 jun 2026) em que o chat reenviava a mesma
 * mensagem dezenas de vezes em segundos (wamids reais distintos = envios reais
 * pra Meta). A Meta classificou como spam e bloqueou a conta (131031). Raiz:
 * exceção pós-enfileiramento no SendMessageActionService fazia o envio (já
 * efetivado) retornar erro, o cliente reenviava e a mensagem duplicava.
 *
 * Detecção: mesma mensagem (mesmo tenant + conta origin_id + conversa
 * request_id + texto), origin 'tenant'/'template', gravada DUPLICATE_THRESHOLD+
 * vezes numa janela <= WINDOW_SECONDS. Janela curta descarta reenvio manual
 * legítimo (operador clicando "Reenviar"), que é esparso.
 */
@injectable()
export class DuplicateSendMonitorJob extends Job {
  readonly name = 'duplicate-send-monitor';
  readonly displayName = 'Mensagens de saída duplicadas em rajada';
  readonly description =
    'Detecta a mesma mensagem de saída (tenant/template) gravada várias vezes ' +
    'em poucos segundos para a mesma conversa/conta — sinal de reenvio em loop ' +
    'que dispara mensagens repetidas pra Meta e pode bloquear a conta por spam.';
  readonly schedule = '*/5 * * * *';

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
    log.info('Procurando mensagens de saída duplicadas em rajada');

    const created = await this.detectNew(log);
    const expired = await this.expireOld(log);

    const ms = Date.now() - t0;
    log.info(
      `Concluída em ${formatDuration(ms)} — ${created} novo(s), ${expired} expirado(s)`,
    );
  }

  private async detectNew(log: Logger): Promise<number> {
    const rows = await this.db.query<BurstRow>(
      `
      SELECT
        tenant_id AS tenant_id,
        origin,
        COALESCE(origin_id::text, '') AS origin_id,
        request_id,
        LEFT(regexp_replace(message, '\\s+', ' ', 'g'), 80) AS message_preview,
        COUNT(*)::int AS dup_count,
        TO_CHAR(MIN(created_at), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_at,
        TO_CHAR(MAX(created_at), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_at,
        EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at)))::int AS window_seconds
      FROM message_logs
      WHERE origin IN ('tenant', 'template')
        AND created_at >= NOW() - make_interval(hours => $1)
      GROUP BY tenant_id, origin, origin_id, request_id, message
      HAVING COUNT(*) >= $2
        AND EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) <= $3
      ORDER BY dup_count DESC
      LIMIT 100
      `,
      [LOOKBACK_HOURS, DUPLICATE_THRESHOLD, WINDOW_SECONDS],
    );

    if (rows.length === 0) {
      log.info('Nenhuma rajada de duplicatas detectada');
      return 0;
    }
    log.warn(`${rows.length} rajada(s) de duplicatas detectada(s)`);

    let novosNoTick = 0;
    for (const row of rows) {
      const fingerprint = `duplicate-outbound::${row.tenant_id}::${row.origin_id}::${row.request_id}::${row.first_at}`;
      const payload: BurstPayload = {
        tenant_id: row.tenant_id,
        origin: row.origin,
        origin_id: row.origin_id,
        request_id: row.request_id,
        dup_count: row.dup_count,
        window_seconds: row.window_seconds,
        first_at: row.first_at,
        last_at: row.last_at,
        message_preview: row.message_preview,
      };

      const created = await this.alertsRepo.insertOpen({
        typeCode: 'duplicate_outbound_burst',
        tenantId: row.tenant_id,
        requestId: row.request_id,
        fingerprint,
        payload,
      });

      if (created) {
        novosNoTick++;
        log.warn(
          `🚨 Rajada #${created.id} tenant=${row.tenant_id.slice(0, 8)} conta=${row.origin_id} ${row.request_id} x${row.dup_count} em ${row.window_seconds}s`,
        );
        await this.notifier.googleChat(this.formatMessage(row));
      }
    }

    return novosNoTick;
  }

  private async expireOld(log: Logger): Promise<number> {
    const open = await this.alertsRepo.listOpenByType('duplicate_outbound_burst');
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
      log.info(`⏰ Rajada #${alert.id} expirada`);
    }
    return expired;
  }

  private formatMessage(row: BurstRow): string {
    const emoji = row.dup_count >= 6 ? '🔴' : '🟡';
    const link = `https://app.desenrolasi.com.br/conversas/${row.request_id}?tenantId=${row.tenant_id}&convChannel=WHATSAPP&convOriginId=${row.origin_id}`;
    return (
      `${emoji} *Mensagens de saída duplicadas em rajada*\n` +
      `*Tenant:* \`${row.tenant_id}\`\n` +
      `*Conta (origin_id):* ${row.origin_id || '(não identificada)'}\n` +
      `*Conversa:* ${row.request_id}\n` +
      `*Origem:* ${row.origin}\n` +
      `*Cópias:* ${row.dup_count}x em ${row.window_seconds}s\n` +
      `*Mensagem:* "${row.message_preview}"\n` +
      `*Período (UTC):* ${row.first_at} → ${row.last_at}\n\n` +
      `⚠️ A mesma mensagem foi enviada várias vezes pra Meta em poucos segundos. ` +
      `Risco de bloqueio da conta por spam (131031). Verificar o caminho de envio ` +
      `(efeitos pós-enfileiramento / reenvio do cliente) desse horário.\n\n` +
      `Conversa: ${link}`
    );
  }
}
