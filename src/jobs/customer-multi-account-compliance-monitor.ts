import { injectable, inject } from 'inversify';
import { Job } from '../lib/job.js';
import { TYPES } from '../lib/types.js';
import { Logger } from '../lib/logger.js';
import { Database } from '../lib/database.js';
import { Notifier } from '../lib/notifier.js';
import { AlertsRepository } from '../lib/repositories/alerts-repository.js';

const WINDOW_MINUTES = 5;
const EXPIRY_HOURS = 6;

type CheckKey =
  | 'customers_without_origin'
  | 'message_logs_without_origin_id'
  | 'service_sessions_without_origin_id'
  | 'conversation_assignments_without_customer_id'
  | 'conversation_read_by_without_customer_id'
  | 'conversation_read_status_without_customer_id';

interface GapRow {
  tenant_id: string;
  n: string;
}

interface CheckSpec {
  key: CheckKey;
  label: string;
  sql: string;
  /**
   * Quando definido, o check só roda se a coluna existir na tabela. Usado
   * pelas checks da Onda 5 (customer_id em conversation_*), que dependem de
   * migration aplicada no backend. Sem esse guard, o monitor quebra com
   * "column does not exist" entre o deploy do monitor e a aplicação da
   * migration em prod.
   */
  requiresColumn?: { table: string; column: string };
}

const CHECKS: CheckSpec[] = [
  {
    key: 'customers_without_origin',
    label: 'customers sem origin/origin_id',
    sql: `
      SELECT tenant_id::text AS tenant_id, COUNT(*)::text AS n
      FROM customers
      WHERE created_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
        AND (origin IS NULL OR origin_id IS NULL)
      GROUP BY tenant_id
    `,
  },
  {
    key: 'message_logs_without_origin_id',
    label: 'message_logs sem origin_id',
    sql: `
      SELECT tenant_id::text AS tenant_id, COUNT(*)::text AS n
      FROM message_logs
      WHERE created_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
        AND origin_id IS NULL
      GROUP BY tenant_id
    `,
  },
  {
    key: 'service_sessions_without_origin_id',
    label: 'service_sessions sem origin_id',
    sql: `
      SELECT tenant_id::text AS tenant_id, COUNT(*)::text AS n
      FROM service_sessions
      WHERE created_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
        AND origin_id IS NULL
      GROUP BY tenant_id
    `,
  },
  {
    key: 'conversation_assignments_without_customer_id',
    label: 'conversation_assignments sem customer_id',
    requiresColumn: { table: 'conversation_assignments', column: 'customer_id' },
    sql: `
      SELECT tenant_id::text AS tenant_id, COUNT(*)::text AS n
      FROM conversation_assignments
      WHERE assigned_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
        AND customer_id IS NULL
      GROUP BY tenant_id
    `,
  },
  {
    key: 'conversation_read_by_without_customer_id',
    label: 'conversation_read_by sem customer_id',
    requiresColumn: { table: 'conversation_read_by', column: 'customer_id' },
    sql: `
      SELECT tenant_id::text AS tenant_id, COUNT(*)::text AS n
      FROM conversation_read_by
      WHERE read_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
        AND customer_id IS NULL
      GROUP BY tenant_id
    `,
  },
  {
    key: 'conversation_read_status_without_customer_id',
    label: 'conversation_read_status sem customer_id',
    requiresColumn: { table: 'conversation_read_status', column: 'customer_id' },
    sql: `
      SELECT tenant_id::text AS tenant_id, COUNT(*)::text AS n
      FROM conversation_read_status
      WHERE created_at >= NOW() - INTERVAL '${WINDOW_MINUTES} minutes'
        AND customer_id IS NULL
      GROUP BY tenant_id
    `,
  },
];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}min ${sec}s`;
}

/**
 * Monitor: compliance da migração multi-contas.
 *
 * Contexto: roadmap em project_multi_account_roadmap. A migração exige que
 * customer/message_log/service_session sejam criados com origin+origin_id e
 * que conversation_assignments/read_by/read_status sejam criados com
 * customer_id. Se algum caller cria sem esses campos, customer pode
 * atravessar contas em tenant multi-WABA — bug original em
 * project_customer_global_bug.
 *
 * Detecção: a cada 5min, conta rows criadas na janela com a coluna de
 * identificação de conta NULL, agrupadas por tenant_id. Notifica por
 * (check, tenant_id) com dedupe horário via AlertsRepository.
 *
 * Critério pra apertar strict (remover fallback do CustomerLookupService e
 * dropar request_id das tabelas conversation_*): monitor zerado por N dias
 * consecutivos em todos os checks.
 */
@injectable()
export class CustomerMultiAccountComplianceJob extends Job {
  readonly name = 'customer-multi-account-compliance-monitor';
  readonly displayName = 'Compliance da migração multi-contas';
  readonly description =
    'Detecta customers/message_logs/service_sessions criados sem origin/origin_id ' +
    'na janela de 5min. Indica caller que não está propagando a conta de origem.';
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
    let novosNoTick = 0;
    let expirados = 0;

    for (const check of CHECKS) {
      const created = await this.runCheck(check, log);
      novosNoTick += created;
    }

    expirados = await this.expireOld(log);

    const ms = Date.now() - t0;
    log.info(
      `Concluída em ${formatDuration(ms)} — ${novosNoTick} novo(s), ${expirados} expirado(s)`,
    );
  }

  private async runCheck(check: CheckSpec, log: Logger): Promise<number> {
    if (check.requiresColumn) {
      const exists = await this.columnExists(
        check.requiresColumn.table,
        check.requiresColumn.column,
      );
      if (!exists) {
        log.debug(
          { check: check.key, ...check.requiresColumn },
          'coluna ainda não existe — skipping (provavelmente migration não aplicada)',
        );
        return 0;
      }
    }

    const rows = await this.db.query<GapRow>(check.sql);
    if (rows.length === 0) {
      log.debug({ check: check.key }, 'sem gaps');
      return 0;
    }

    let novos = 0;
    for (const row of rows) {
      const count = parseInt(row.n, 10);
      if (count === 0) continue;

      const bucket = bucketTimestamp();
      const fingerprint = `multi-account-gap::${check.key}::${row.tenant_id}::${bucket}`;
      const created = await this.alertsRepo.insertOpen({
        typeCode: 'multi_account_compliance_gap',
        tenantId: row.tenant_id,
        fingerprint,
        payload: {
          check: check.key,
          label: check.label,
          tenant_id: row.tenant_id,
          count,
          window_minutes: WINDOW_MINUTES,
        },
      });

      if (created) {
        novos++;
        log.warn(
          `🚨 Gap #${created.id} ${check.key} tenant=${row.tenant_id.slice(0, 8)} count=${count}`,
        );
        await this.notifier.googleChat(
          this.formatMessage(check, row.tenant_id, count),
        );
      }
    }

    return novos;
  }

  private async expireOld(log: Logger): Promise<number> {
    const open = await this.alertsRepo.listOpenByType(
      'multi_account_compliance_gap',
    );
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
      log.info(`⏰ Gap alert #${alert.id} expirado`);
    }
    return expired;
  }

  private async columnExists(
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = $1
           AND column_name = $2
       ) AS exists`,
      [table, column],
    );
    return rows[0]?.exists === true;
  }

  private formatMessage(
    check: CheckSpec,
    tenantId: string,
    count: number,
  ): string {
    const missingColumn = check.key.endsWith('_without_customer_id')
      ? 'customer_id'
      : 'origin/origin_id';
    const table = check.label.replace(/\s+sem\s+(customer_id|origin_id|origin\/origin_id)$/, '');
    return (
      `🚨 *Multi-conta compliance gap*\n` +
      `*Check:* ${check.label}\n` +
      `*Tenant:* \`${tenantId}\`\n` +
      `*Count nos últimos ${WINDOW_MINUTES}min:* ${count}\n\n` +
      `*Diagnóstico:* algum caller criou ${table} sem propagar ${missingColumn}. ` +
      `Customer pode atravessar contas em tenant multi-WABA. ` +
      `Investigar caller via stack trace ou git log do tenant ${tenantId}.\n\n` +
      `Ref: project_multi_account_roadmap.`
    );
  }
}

/**
 * Timestamp truncado a hora — pra que alerts do mesmo (check, tenant) sejam
 * deduplicados dentro da mesma hora, mas re-notifiquem se o problema persistir
 * em hora seguinte.
 */
function bucketTimestamp(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}`;
}
