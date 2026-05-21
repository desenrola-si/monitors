import { injectable, inject } from 'inversify';
import { Job } from '../../lib/job.js';
import { TYPES } from '../../lib/types.js';
import { Logger } from '../../lib/logger.js';
import { Database } from '../../lib/database.js';
import {
  PortfolioRepository,
  InsertSignalArgs,
} from '../../lib/repositories/portfolio-repository.js';
import { listPortfolioTenants } from './tenants.js';
import { buildYesterdayWindow } from './window.js';
import { VolumeDimension } from './dimensions/volume.js';
import { FrustrationDimension } from './dimensions/frustration.js';
import { ConversionDimension } from './dimensions/conversion.js';
import { OperationsDimension } from './dimensions/operations.js';
import { computeOverallStatus } from './status.js';
import { narrateOverall } from './narrator.js';
import { Dimension, DimensionResult } from './types.js';

/**
 * Relatório executivo diário do portfólio — uma visão "dono da Desenrola"
 * sobre cada cliente. Não substitui o health-check técnico (que continua
 * postando alertas operacionais no Chat). Este job apenas persiste um
 * snapshot por (tenant, report_date) consumido pelo dashboard.
 *
 * Roda 07:00 BRT (1h depois do daily-reports). Idempotente via UNIQUE
 * (tenant_id, report_date) + ON CONFLICT DO UPDATE.
 *
 * Pipeline por tenant:
 *   1. Roda 4 dimensions (queries determinísticas em desenrola + monitors)
 *   2. Classifica overall_status com computeOverallStatus
 *   3. Gera narrativa LLM (deepseek-v4-flash) — fallback determinístico se LLM cair
 *   4. Persiste snapshot + 4 signals
 *
 * Placeholder tenants (workflow_slug TODO* ou nulo) entram com
 * `ai_configured=false` e narrativa fixa "oportunidade de ativação".
 */
@injectable()
export class PortfolioReportJob extends Job {
  readonly name = 'portfolio-report';
  readonly displayName = 'Saúde do Portfólio';
  readonly description =
    'Toda manhã às 7h, monta um snapshot executivo por cliente: volume, ' +
    'frustração, conversão e saúde operacional. Aparece em /saude-portfolio ' +
    'pra você ver onde dar atenção e onde explorar.';
  readonly schedule = '0 7 * * *';

  private readonly dimensions: Dimension[];

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.Database) private readonly db: Database,
    @inject(TYPES.PortfolioRepository)
    private readonly repo: PortfolioRepository,
  ) {
    super();
    this.dimensions = [
      new VolumeDimension(),
      new FrustrationDimension(),
      new ConversionDimension(),
      new OperationsDimension(),
    ];
  }

  async run(): Promise<void> {
    const log = this.logger.child({ job: this.name });
    const t0 = Date.now();
    const window = buildYesterdayWindow();
    log.info(
      `Gerando relatório do portfólio para ${window.reportDate} (baseline 7d anteriores)`,
    );

    const tenants = await listPortfolioTenants(this.db);
    log.info(
      `${tenants.length} cliente(s) ativos — ${tenants.filter((t) => t.isPlaceholder).length} sem IA configurada`,
    );

    let processed = 0;
    let failed = 0;

    for (const tenant of tenants) {
      try {
        await this.processTenant(tenant, window, log);
        processed++;
      } catch (err) {
        failed++;
        log.error(
          { tenant: tenant.id, err: (err as Error).message },
          `Falhou ao processar ${tenant.name ?? tenant.id} — pulando`,
        );
      }
    }

    log.info(
      `Relatório concluído em ${Date.now() - t0}ms — ` +
        `${processed} processado(s), ${failed} falha(s)`,
    );
  }

  private async processTenant(
    tenant: ReturnType<typeof listPortfolioTenants> extends Promise<infer R>
      ? R extends Array<infer U>
        ? U
        : never
      : never,
    window: ReturnType<typeof buildYesterdayWindow>,
    log: Logger,
  ): Promise<void> {
    const ctx = { db: this.db, log, tenant, window };
    const signals: DimensionResult[] = [];

    for (const dim of this.dimensions) {
      try {
        const result = await dim.run(ctx);
        signals.push(result);
      } catch (err) {
        log.warn(
          {
            tenant: tenant.id,
            dim: dim.code,
            err: (err as Error).message,
          },
          `Dimensão ${dim.code} falhou — registrando como unknown`,
        );
        signals.push({
          dimension: dim.code,
          currentValue: null,
          baselineValue: null,
          deltaPct: null,
          status: 'unknown',
          narrative: `Falha ao calcular ${dim.code}: ${(err as Error).message}`,
          rawData: { error: (err as Error).message },
        });
      }
    }

    const overall = computeOverallStatus(signals);
    const narration = await narrateOverall(
      { tenant, overallStatus: overall, signals },
      log,
    );

    const snapshotId = await this.repo.insertSnapshot({
      reportDate: window.reportDate,
      tenantId: tenant.id,
      tenantName: tenant.name,
      aiConfigured: !tenant.isPlaceholder,
      overallStatus: overall,
      overallNarrative: narration?.narrative ?? null,
      llmModel: narration?.model ?? null,
      llmTokensInput: narration?.tokensInput ?? null,
      llmTokensOutput: narration?.tokensOutput ?? null,
    });

    // Re-run de mesmo dia: limpa signals antigos antes de re-inserir
    await this.repo.deleteSignalsForSnapshot(snapshotId);

    const toInsert: InsertSignalArgs[] = signals.map((s) => ({
      snapshotId,
      dimension: s.dimension,
      currentValue: s.currentValue,
      baselineValue: s.baselineValue,
      deltaPct: s.deltaPct,
      signalStatus: s.status,
      narrative: s.narrative,
      rawData: s.rawData,
    }));
    await this.repo.insertSignals(toInsert);

    log.info(
      `  ${tenant.name ?? tenant.id} → ${overall}: ${narration?.narrative ?? '(sem narrativa)'}`,
    );
  }
}
