import { injectable, inject } from 'inversify';
import { Job } from '../lib/job.js';
import { TYPES } from '../lib/types.js';
import { Logger } from '../lib/logger.js';
import { Database } from '../lib/database.js';
import { Notifier } from '../lib/notifier.js';
import {
  AlertsRepository,
  AlertRow,
} from '../lib/repositories/alerts-repository.js';

const TENANT_ID = 'b14ddbae-1543-46b5-b3fa-e314c10c31b9'; // Amilgás
const TENANT_NAME = 'Amilgás';

// Regex de sinais de frustração / contestação. Mantido idêntico ao monitor.py
const FRUSTRATION_SIGNAL_REGEX =
  'n[ãa]o\\s+entend(o|i|emos)|t[áa]\\s+errado|est[áa]\\s+errado|' +
  '(vcs|voc[êe]s|vc)\\s+n[ãa]o\\s+(tem|t[êe]m)|' +
  'n[ãa]o\\s+tinha\\s+(esses|estes|isso)|n[ãa]o\\s+procede|' +
  'n[ãa]o\\s+(é|e)\\s+isso|' +
  '(meu|minha)\\s+(marido|esposa|familiar|filh[oa])\\s+acompanhou|' +
  'houve\\s+troca|n[ãa]o\\s+(faz|tem)\\s+sentido|' +
  't[ôo]\\s+perdido|que\\s+confus[ãa]o|discordo|' +
  'laudo\\s+(errado|incorreto|n[ãa]o)|n[ãa]o\\s+bate|' +
  'isso\\s+(n[ãa]o|nao)\\s+funciona';

// Padrão de mensagem da IA oferecendo handoff humano
const IA_HANDOFF_REGEX =
  'transferir.*(atendente|humano)|atendente\\s+humano|' +
  'um\\s+atendente\\s+nosso|vou\\s+transferir|encaminhar.*atendente';

// Mensagem CURTA do cliente que indica aceitação após o sinal de frustração.
// Aplicado só pra mensagens com length < 30.
const USER_ACK_REGEX =
  '^\\s*(ok|blz|beleza|valeu|obrigad[ao]s?|' +
  't[áa]\\s+(ok|bom|certo|joia|tranquilo)|' +
  'perfeito|certo|isso|entend[ai]|entendido|sim|' +
  'combinad[ao]|joia|legal|otimo|[óo]timo)[\\s!.…👍✅🙏]*$';

const EXPIRY_HOURS = 24;

interface FrustrationRow {
  phone: string;
  first_signal_utc: string;
  first_signal_brt: string;
  signals: string;
}

interface FrustrationPayload extends Record<string, unknown> {
  first_signal_utc: string;
  first_signal_brt: string;
  signals: string;
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
 * Monitor que detecta conversas Amilgás com sinal de frustração não escalada.
 *
 * Fluxo (rodando a cada 5min):
 *   1. Detecta sinais ATIVOS (sem ack, sem humano, sem IA-handoff) na janela 24h
 *   2. Pra cada sinal: insere alert (open) idempotente via fingerprint
 *      - Se INSERT novo → posta "🚨 novo alert" no Google Chat
 *      - Se já existia → skip notify (resolução vem no passo 3)
 *   3. Re-avalia todos alerts `open` desse tipo:
 *      - Humano respondeu desde o sinal → resolved_by_human
 *      - Cliente acked (msg curta de aceitação) → resolved_by_ai
 *      - > 24h sem nenhum dos dois → expired
 *      Em cada transição posta no Google Chat o desfecho
 */
@injectable()
export class FrustrationMonitorJob extends Job {
  readonly name = 'frustration-monitor';
  readonly displayName = `Alerta de Frustração — ${TENANT_NAME}`;
  readonly description =
    'Avisa quando um cliente da Amilgás demonstra confusão ou contestação ' +
    'durante o atendimento e a IA não passa pra uma pessoa. Posta no Google ' +
    'Chat e acompanha cada caso até ser resolvido ou expirar.';
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
    log.info(`Começando checagem da ${TENANT_NAME}`);

    const detected = await this.detectNew(log);
    const resolved = await this.reEvaluateOpen(log);

    const ms = Date.now() - t0;
    const novos =
      detected === 0 ? 'nenhum alerta novo' : `${detected} alerta(s) novo(s)`;
    const fechados =
      resolved === 0 ? 'nenhum resolvido' : `${resolved} resolvido(s)`;
    log.info(
      `Checagem concluída em ${formatDuration(ms)} — ${novos}, ${fechados}`,
    );
  }

  // — Passo 1: novos sinais ativos viram alerts —
  private async detectNew(log: Logger): Promise<number> {
    const sinceUtc = new Date(Date.now() - 24 * 3600 * 1000);
    const handoffLookbackUtc = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    log.debug('Procurando sinais novos da última 24h');

    const rows = await this.db.query<FrustrationRow>(
      `
      WITH frust AS (
        SELECT request_id, MIN(receivad_at) AS first_signal,
          array_agg(LEFT(message, 120) ORDER BY receivad_at) AS signals
        FROM message_logs
        WHERE tenant_id = $1
          AND receivad_at >= $2::timestamp
          AND origin = 'user'
          AND message ~* $3
        GROUP BY request_id
      )
      SELECT f.request_id AS phone,
        TO_CHAR(f.first_signal, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_signal_utc,
        TO_CHAR((f.first_signal AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI:SS') AS first_signal_brt,
        array_to_string(f.signals, ' | ') AS signals
      FROM frust f
      WHERE NOT EXISTS (
        SELECT 1 FROM message_logs h
        WHERE h.tenant_id = $1
          AND h.request_id = f.request_id
          AND h.receivad_at >= $4::timestamp
          AND h.origin IN ('tenant', 'guard_handoff')
      )
      AND NOT EXISTS (
        SELECT 1 FROM message_logs i
        WHERE i.tenant_id = $1
          AND i.request_id = f.request_id
          AND i.receivad_at >= $4::timestamp
          AND i.origin = 'agent'
          AND i.message ~* $5
      )
      AND NOT EXISTS (
        SELECT 1 FROM message_logs ack
        WHERE ack.tenant_id = $1
          AND ack.request_id = f.request_id
          AND ack.receivad_at > f.first_signal
          AND ack.receivad_at <= f.first_signal + INTERVAL '30 minutes'
          AND ack.origin = 'user'
          AND length(ack.message) < 30
          AND ack.message ~* $6
      )
      ORDER BY f.first_signal DESC
      `,
      [
        TENANT_ID,
        sinceUtc.toISOString(),
        FRUSTRATION_SIGNAL_REGEX,
        handoffLookbackUtc.toISOString(),
        IA_HANDOFF_REGEX,
        USER_ACK_REGEX,
      ],
    );

    if (rows.length === 0) {
      log.info('Nenhum cliente sinalizou frustração nas últimas 24h');
      return 0;
    }
    log.info(
      `${rows.length} ${rows.length === 1 ? 'cliente sinalizou' : 'clientes sinalizaram'} frustração nas últimas 24h`,
    );

    let novosNoTick = 0;
    for (const row of rows) {
      const phone = formatPhone(row.phone);
      log.info(
        `→ ${phone} reclamou em ${row.first_signal_brt} BRT: "${row.signals.slice(0, 80)}..."`,
      );

      const fingerprint = `frust::${TENANT_ID}::${row.phone}::${row.first_signal_utc}`;
      const payload: FrustrationPayload = {
        first_signal_utc: row.first_signal_utc,
        first_signal_brt: row.first_signal_brt,
        signals: row.signals,
        phone_formatted: phone,
      };

      const created = await this.alertsRepo.insertOpen({
        typeCode: 'frustration_not_escalated',
        tenantId: TENANT_ID,
        requestId: row.phone,
        fingerprint,
        payload,
      });

      if (created) {
        novosNoTick++;
        log.warn(
          `🚨 Novo alerta criado pra ${phone} (#${created.id}) — avisando no Google Chat`,
        );
        await this.notifier.googleChat(this.formatNewAlertMessage(row));
        log.info(`✅ Notificação do alerta #${created.id} enviada`);
      } else {
        log.debug(`${phone} já tinha alerta aberto, não notifico de novo`);
      }
    }

    if (novosNoTick === 0) {
      log.info(
        `Todos os ${rows.length} já estavam sendo monitorados, nada novo`,
      );
    }
    return novosNoTick;
  }

  // — Passo 2: re-avalia alerts open pra ver se resolveram —
  private async reEvaluateOpen(log: Logger): Promise<number> {
    const open = await this.alertsRepo.listOpenByType(
      'frustration_not_escalated',
    );
    if (open.length === 0) {
      log.debug('Sem alertas em aberto pra acompanhar');
      return 0;
    }
    log.info(
      `${open.length} ${open.length === 1 ? 'alerta em aberto sendo acompanhado' : 'alertas em aberto sendo acompanhados'}`,
    );

    let resolvedCount = 0;
    for (const alert of open) {
      const payload = alert.payload as FrustrationPayload;
      const phone = payload.phone_formatted;
      log.debug(`Verificando alerta #${alert.id} (${phone})`);

      const resolution = await this.checkResolution(alert);
      if (!resolution) {
        log.debug(`Alerta #${alert.id} ainda não foi resolvido`);
        continue;
      }

      const desfecho =
        resolution.byStatusCode === 'resolved_by_ai'
          ? '🤖 Resolvido pela IA'
          : resolution.byStatusCode === 'resolved_by_human'
            ? '✅ Resolvido por humano'
            : '⏰ Expirou sem resolução';
      log.info(
        `${desfecho} — alerta #${alert.id} (${phone}): ${resolution.note}`,
      );

      await this.alertsRepo.markResolved(alert.id, resolution);
      await this.notifier.googleChat(
        this.formatResolutionMessage(alert, resolution),
      );
      resolvedCount++;
    }

    if (resolvedCount === 0) {
      log.info('Nenhum dos alertas em aberto teve desfecho ainda');
    }
    return resolvedCount;
  }



  private async checkResolution(alert: AlertRow): Promise<{
    byStatusCode: 'resolved_by_ai' | 'resolved_by_human' | 'expired';
    note: string;
    evidence: Record<string, unknown>;
  } | null> {
    const payload = alert.payload as FrustrationPayload;
    const firstSignalUtc = payload.first_signal_utc;

    // 1) Humano respondeu?
    const humanRows = await this.db.query<{
      ts_brt: string;
      origin: string;
      message: string;
    }>(
      `
      SELECT
        TO_CHAR((receivad_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI:SS') AS ts_brt,
        origin,
        LEFT(message, 200) AS message
      FROM message_logs
      WHERE tenant_id = $1
        AND request_id = $2
        AND receivad_at > $3::timestamp
        AND origin IN ('tenant', 'guard_handoff')
      ORDER BY receivad_at ASC
      LIMIT 1
      `,
      [TENANT_ID, alert.requestId, firstSignalUtc],
    );

    if (humanRows[0]) {
      const h = humanRows[0];
      return {
        byStatusCode: 'resolved_by_human',
        note: `Humano respondeu às ${h.ts_brt} BRT (${h.origin})`,
        evidence: { ts_brt: h.ts_brt, origin: h.origin, message: h.message },
      };
    }

    // 2) Cliente acked (msg curta de aceitação)?
    const ackRows = await this.db.query<{
      ts_brt: string;
      message: string;
    }>(
      `
      SELECT
        TO_CHAR((receivad_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI:SS') AS ts_brt,
        LEFT(message, 200) AS message
      FROM message_logs
      WHERE tenant_id = $1
        AND request_id = $2
        AND receivad_at > $3::timestamp
        AND origin = 'user'
        AND length(message) < 30
        AND message ~* $4
      ORDER BY receivad_at ASC
      LIMIT 1
      `,
      [TENANT_ID, alert.requestId, firstSignalUtc, USER_ACK_REGEX],
    );

    if (ackRows[0]) {
      const a = ackRows[0];
      return {
        byStatusCode: 'resolved_by_ai',
        note: `Cliente confirmou "${a.message.trim()}" às ${a.ts_brt} BRT após esclarecimento da IA`,
        evidence: { ts_brt: a.ts_brt, ack_message: a.message },
      };
    }

    // 3) Expirou?
    const ageMs = Date.now() - new Date(alert.notifiedAt).getTime();
    if (ageMs > EXPIRY_HOURS * 3600 * 1000) {
      return {
        byStatusCode: 'expired',
        note: `Sem resolução em ${EXPIRY_HOURS}h — nem humano respondeu, nem cliente acked`,
        evidence: { age_ms: ageMs },
      };
    }

    return null;
  }

  // — Formatação de mensagens Google Chat —

  private formatNewAlertMessage(row: FrustrationRow): string {
    const phone = formatPhone(row.phone);
    return (
      `🚨 *${TENANT_NAME} — Frustração/Contestação NÃO escalada*\n` +
      `*Cliente:* ${phone}\n` +
      `*1º sinal:* ${row.first_signal_brt} BRT\n` +
      `*Sinais detectados:*\n${row.signals.slice(0, 400)}\n\n` +
      `*Diagnóstico:* ⚠️ Cliente expressou confusão/contestação. A IA não chamou ` +
      `\`request_human_intervention\` nem houve handoff humano até agora. ` +
      `Monitorando — vou postar aqui quando resolver.\n\n` +
      `Ver conversa: https://app.desenrolasi.com.br/conversas/${row.phone}?tenantId=${TENANT_ID}`
    );
  }

  private formatResolutionMessage(
    alert: AlertRow,
    resolution: { byStatusCode: string; note: string },
  ): string {
    const payload = alert.payload as FrustrationPayload;
    const emoji =
      resolution.byStatusCode === 'resolved_by_human'
        ? '✅'
        : resolution.byStatusCode === 'resolved_by_ai'
          ? '🤖✅'
          : '⏰';
    const label =
      resolution.byStatusCode === 'resolved_by_human'
        ? 'RESOLVIDO POR HUMANO'
        : resolution.byStatusCode === 'resolved_by_ai'
          ? 'RESOLVIDO PELA IA'
          : 'EXPIROU SEM RESOLUÇÃO';

    return (
      `${emoji} *${TENANT_NAME} — Alert #${alert.id}: ${label}*\n` +
      `*Cliente:* ${payload.phone_formatted}\n` +
      `*1º sinal:* ${payload.first_signal_brt} BRT\n` +
      `*Resolução:* ${resolution.note}\n\n` +
      `Ver conversa: https://app.desenrolasi.com.br/conversas/${alert.requestId}?tenantId=${TENANT_ID}`
    );
  }
}
