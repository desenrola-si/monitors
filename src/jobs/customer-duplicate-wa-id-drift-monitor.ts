import { injectable, inject } from 'inversify';
import { Job } from '../lib/job.js';
import { TYPES } from '../lib/types.js';
import { Logger } from '../lib/logger.js';
import { Database } from '../lib/database.js';
import { Notifier } from '../lib/notifier.js';
import { AlertsRepository } from '../lib/repositories/alerts-repository.js';

const SINCE_UTC_HARDCODED = '2026-06-01 15:00:00';
const LOOKBACK_HOURS = 6;
const EXPIRY_DAYS = 3;

interface DriftRow {
  new_customer_id: string;
  new_requester_id: string;
  new_name: string;
  new_created_at: string;
  old_customer_id: string;
  old_requester_id: string;
  old_name: string;
  old_created_at: string;
  tenant_id: string;
}

interface DriftPayload extends Record<string, unknown> {
  new_customer_id: string;
  new_requester_id: string;
  new_name: string;
  old_customer_id: string;
  old_requester_id: string;
  old_name: string;
  tenant_id: string;
  diff_kind: 'has_9th_digit' | 'missing_9th_digit';
}

function formatPhone(raw: string): string {
  if (raw.length === 13 && raw.startsWith('55')) {
    return `(${raw.slice(2, 4)}) ${raw.slice(4, 5)} ${raw.slice(5, 9)}-${raw.slice(9)}`;
  }
  if (raw.length === 12 && raw.startsWith('55')) {
    return `(${raw.slice(2, 4)}) ${raw.slice(4, 8)}-${raw.slice(8)}`;
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
 * Monitor: customer duplicado por drift do 9º dígito BR.
 *
 * Contexto: PR #571 (1º jun 2026) fez send-template gravar
 * MessageLog.request_id = wa_id da Meta em vez do número normalizado.
 * Customer pré-existente tinha requester_id A (com ou sem 9º dígito).
 * Após o fix, próxima interação via template pode criar customer NOVO
 * com requester_id B (formato diferente). Mesma pessoa, duas linhas.
 *
 * Detecção: customer novo (pós SINCE_UTC_HARDCODED) cujo requester_id
 * difere de outro customer do MESMO tenant APENAS pelo 9º dígito
 * (DDI 55 + DDD igual + últimos 8 dígitos do número igual).
 */
@injectable()
export class CustomerDuplicateWaIdDriftJob extends Job {
  readonly name = 'customer-duplicate-wa-id-drift-monitor';
  readonly displayName = 'Customer duplicado por drift do 9º dígito';
  readonly description =
    'Detecta customers criados pós-deploy do PR #571 cujo requester_id ' +
    'difere de customer existente do mesmo tenant apenas pelo 9º dígito ' +
    '(possível duplicação por mudança de chave wa_id vs número normalizado).';
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
    log.info('Procurando customers duplicados por drift do 9º dígito');

    const created = await this.detectNew(log);
    const expired = await this.expireOld(log);

    const ms = Date.now() - t0;
    log.info(
      `Concluída em ${formatDuration(ms)} — ${created} novo(s), ${expired} expirado(s)`,
    );
  }

  private async detectNew(log: Logger): Promise<number> {
    const sinceUtc = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000);
    const effectiveSince =
      sinceUtc.toISOString() > SINCE_UTC_HARDCODED
        ? sinceUtc.toISOString()
        : SINCE_UTC_HARDCODED;

    const rows = await this.db.query<DriftRow>(
      `
      SELECT
        c1.id::text AS new_customer_id,
        c1.requester_id AS new_requester_id,
        COALESCE(c1.name, '') AS new_name,
        TO_CHAR(c1.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS new_created_at,
        c2.id::text AS old_customer_id,
        c2.requester_id AS old_requester_id,
        COALESCE(c2.name, '') AS old_name,
        TO_CHAR(c2.created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS old_created_at,
        c1.tenant_id::text AS tenant_id
      FROM customers c1
      JOIN customers c2
        ON c2.tenant_id = c1.tenant_id
        AND c2.id <> c1.id
        AND c2.created_at < c1.created_at
        AND c1.requester_id <> c2.requester_id
        -- DDI + DDD batem
        AND LEFT(c1.requester_id, 4) = LEFT(c2.requester_id, 4)
        -- últimos 8 dígitos batem (número sem 9º)
        AND RIGHT(c1.requester_id, 8) = RIGHT(c2.requester_id, 8)
        -- exatamente 1 dígito de diferença no tamanho
        AND ABS(LENGTH(c1.requester_id) - LENGTH(c2.requester_id)) = 1
      WHERE c1.created_at >= $1::timestamptz
        AND LEFT(c1.requester_id, 2) = '55'
      ORDER BY c1.created_at DESC
      LIMIT 100
      `,
      [effectiveSince],
    );

    if (rows.length === 0) {
      log.info('Nenhum customer duplicado por drift detectado');
      return 0;
    }
    log.warn(`${rows.length} possível(is) duplicação(ões) por drift`);

    let novosNoTick = 0;
    for (const row of rows) {
      const diffKind: 'has_9th_digit' | 'missing_9th_digit' =
        row.new_requester_id.length > row.old_requester_id.length
          ? 'has_9th_digit'
          : 'missing_9th_digit';

      const fingerprint = `customer-drift::${row.tenant_id}::${row.new_customer_id}::${row.old_customer_id}`;
      const payload: DriftPayload = {
        new_customer_id: row.new_customer_id,
        new_requester_id: row.new_requester_id,
        new_name: row.new_name,
        old_customer_id: row.old_customer_id,
        old_requester_id: row.old_requester_id,
        old_name: row.old_name,
        tenant_id: row.tenant_id,
        diff_kind: diffKind,
      };

      const created = await this.alertsRepo.insertOpen({
        typeCode: 'customer_duplicate_wa_id_drift',
        tenantId: row.tenant_id,
        requestId: row.new_requester_id,
        fingerprint,
        payload,
      });

      if (created) {
        novosNoTick++;
        log.warn(
          `🚨 Drift #${created.id} tenant=${row.tenant_id.slice(0, 8)} ${formatPhone(row.old_requester_id)} → ${formatPhone(row.new_requester_id)}`,
        );
        await this.notifier.googleChat(this.formatMessage(row, diffKind));
      }
    }

    return novosNoTick;
  }

  private async expireOld(log: Logger): Promise<number> {
    const open = await this.alertsRepo.listOpenByType(
      'customer_duplicate_wa_id_drift',
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
      log.info(`⏰ Drift alert #${alert.id} expirado`);
    }
    return expired;
  }

  private formatMessage(
    row: DriftRow,
    diffKind: 'has_9th_digit' | 'missing_9th_digit',
  ): string {
    const newPhone = formatPhone(row.new_requester_id);
    const oldPhone = formatPhone(row.old_requester_id);
    return (
      `🚨 *Customer duplicado por drift do 9º dígito (PR #571)*\n` +
      `*Tenant:* \`${row.tenant_id}\`\n` +
      `*Customer EXISTENTE:* ${oldPhone} (\`${row.old_requester_id}\`) — ${row.old_name || '(sem nome)'}\n` +
      `*Customer NOVO:* ${newPhone} (\`${row.new_requester_id}\`) — ${row.new_name || '(sem nome)'}\n` +
      `*Diferença:* ${diffKind === 'has_9th_digit' ? 'novo TEM 9º dígito (antigo NÃO)' : 'novo NÃO tem 9º dígito (antigo TEM)'}\n\n` +
      `*Diagnóstico:* ⚠️ Mesma pessoa pode ter duas linhas em customers ` +
      `após mudança de chave wa_id. Considerar consolidar ou fazer rollback ` +
      `do PR #571 se padrão se repetir.\n\n` +
      `Ver conversa nova: https://app.desenrolasi.com.br/conversas/${row.new_requester_id}?tenantId=${row.tenant_id}\n` +
      `Ver conversa antiga: https://app.desenrolasi.com.br/conversas/${row.old_requester_id}?tenantId=${row.tenant_id}`
    );
  }
}
