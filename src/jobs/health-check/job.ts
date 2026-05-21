import { injectable, inject } from 'inversify';
import { Job } from '../../lib/job.js';
import { TYPES } from '../../lib/types.js';
import { Logger } from '../../lib/logger.js';
import { Database } from '../../lib/database.js';
import { Notifier } from '../../lib/notifier.js';
import {
  AlertsRepository,
  AlertRow,
} from '../../lib/repositories/alerts-repository.js';
import {
  HealthCheckRepository,
  InsertFindingArgs,
} from '../../lib/repositories/health-check-repository.js';
import { Check, CheckResult } from './check.js';
import { MessageFailuresCheck } from './checks/message-failures.js';
import { WorkflowFailuresCheck } from './checks/workflow-failures.js';
import { Wa24hWindowCheck } from './checks/wa-24h-window.js';
import { IgDmSilentDropCheck } from './checks/ig-dm-silent-drop.js';

interface ProblemPayload extends Record<string, unknown> {
  severity: 'warning' | 'critical';
  metric_value: number | null;
  tenant_name: string | null;
  notification_text: string;
}

/**
 * Job de saúde geral: roda 4 checks (em sequência pra não topar o banco) que
 * varrem TODOS os tenants procurando problemas. Cada check faz 1 query
 * agregada (GROUP BY tenant_id).
 *
 * Lifecycle (igual ao FrustrationMonitor):
 *   1. Pra cada problema detectado: insertOpen no `alerts` (idempotente via
 *      fingerprint=check::tenant)
 *      - Novo → 🚨 posta no Google Chat
 *      - Existente → no-op
 *   2. Pra alerts open desses tipos que NÃO apareceram no tick: markResolved
 *      com status='resolved_auto' + posta "✅ voltou ao normal"
 *
 * Snapshot histórico:
 *   - INSERT em `health_check_runs` (1 row por execução)
 *   - INSERT em `health_check_findings` (N rows, 1 por tenant problemático)
 *   - Permite dashboard mostrar timeline e ranking
 */
@injectable()
export class HealthCheckJob extends Job {
  readonly name = 'health-check';
  readonly displayName = 'Saúde Geral dos Tenants';
  readonly description =
    'A cada 30min varre todos os tenants procurando mensagens falhando, ' +
    'workflows travando, janela WhatsApp fechada e DM Instagram presa. Cria ' +
    'alertas no Google Chat e mantém histórico no banco pra dashboard.';
  readonly schedule = '*/30 * * * *';

  private readonly checks: Check[];

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.Database) private readonly db: Database,
    @inject(TYPES.Notifier) private readonly notifier: Notifier,
    @inject(TYPES.AlertsRepository)
    private readonly alertsRepo: AlertsRepository,
    @inject(TYPES.HealthCheckRepository)
    private readonly healthRepo: HealthCheckRepository,
  ) {
    super();
    this.checks = [
      new MessageFailuresCheck(),
      new WorkflowFailuresCheck(),
      new Wa24hWindowCheck(),
      new IgDmSilentDropCheck(),
    ];
  }

  async run(): Promise<void> {
    const log = this.logger.child({ job: this.name });
    const t0 = Date.now();
    log.info('Começando checagem geral de saúde dos tenants');

    const runId = await this.healthRepo.startRun(null).catch((err: Error) => {
      log.warn(`Falha ao iniciar snapshot: ${err.message}`);
      return null;
    });

    const findings: InsertFindingArgs[] = [];
    const summary: Record<string, number> = {};
    const allTenantsWithProblems = new Set<string>();
    let totalNotified = 0;
    let totalResolved = 0;

    for (const check of this.checks) {
      log.debug(`Rodando check: ${check.code}`);
      let results: CheckResult[] = [];
      try {
        results = await check.run({ db: this.db, log });
      } catch (err) {
        log.error(
          { err, check: check.code },
          `Check ${check.code} falhou — pulando`,
        );
        summary[check.code] = 0;
        continue;
      }

      summary[check.code] = results.length;

      if (results.length === 0) {
        log.info(`  ${check.code}: nenhum problema`);
      } else {
        log.warn(
          `  ${check.code}: ${results.length} tenant(s) com problema`,
        );
      }

      // Pra cada problema novo, cria alert + notifica
      for (const r of results) {
        allTenantsWithProblems.add(r.tenantId);
        if (runId) {
          findings.push({
            healthCheckRunId: runId,
            tenantId: r.tenantId,
            tenantName: r.tenantName,
            checkCode: check.code,
            severity: r.severity,
            metricValue: r.metricValue,
            payload: r.payload,
          });
        }

        const fingerprint = `${check.code}::${r.tenantId}`;
        const payload: ProblemPayload = {
          severity: r.severity,
          metric_value: r.metricValue,
          tenant_name: r.tenantName,
          notification_text: r.notificationText,
          ...r.payload,
        };

        const created = await this.alertsRepo.insertOpen({
          typeCode: check.alertTypeCode,
          tenantId: r.tenantId,
          fingerprint,
          payload,
        });

        if (created) {
          totalNotified++;
          log.warn(`🚨 Novo alerta #${created.id}: ${r.notificationText}`);
          await this.notifier.googleChat(r.notificationText);
        }
      }

      // Auto-resolve: alerts open desse tipo que NÃO apareceram no tick atual
      const openAlerts = await this.alertsRepo.listOpenByType(
        check.alertTypeCode,
      );
      const currentTenantIds = new Set(results.map((r) => r.tenantId));
      for (const alert of openAlerts) {
        if (alert.tenantId && currentTenantIds.has(alert.tenantId)) continue;
        const oldPayload = alert.payload as ProblemPayload;
        const tenantLabel = oldPayload.tenant_name ?? alert.tenantId ?? '?';
        const resolutionNote = `Condição voltou ao normal — ${check.description.toLowerCase()} não detectada mais.`;
        await this.alertsRepo.markResolved(alert.id, {
          byStatusCode: 'resolved_auto',
          note: resolutionNote,
          evidence: { resolved_at: new Date().toISOString() },
        });
        await this.notifier.googleChat(
          `✅ *${tenantLabel}* — alerta #${alert.id} (${check.code}) voltou ao normal.`,
        );
        totalResolved++;
        log.info(
          `✅ Alerta #${alert.id} (${tenantLabel}) auto-resolvido — ${check.code}`,
        );
      }
    }

    // Persiste findings e fecha snapshot
    if (runId && findings.length > 0) {
      try {
        await this.healthRepo.insertFindings(findings);
      } catch (err) {
        log.warn(
          `Falha ao persistir ${findings.length} findings: ${(err as Error).message}`,
        );
      }
    }

    const durationMs = Date.now() - t0;
    const totalProblems = findings.length;
    if (runId) {
      await this.healthRepo
        .finishRun(runId, {
          totalTenants: allTenantsWithProblems.size,
          totalProblems,
          summary,
          durationMs,
        })
        .catch((err: Error) =>
          log.warn(`Falha ao fechar snapshot: ${err.message}`),
        );
    }

    log.info(
      `Checagem concluída em ${durationMs}ms — ` +
        `${totalProblems} achados em ${allTenantsWithProblems.size} tenant(s), ` +
        `${totalNotified} alerta(s) novo(s), ${totalResolved} resolvido(s) automaticamente`,
    );
  }
}
