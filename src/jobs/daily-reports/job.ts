import { injectable, inject } from 'inversify';
import { Job } from '../../lib/job.js';
import { TYPES } from '../../lib/types.js';
import { Logger } from '../../lib/logger.js';
import { Database } from '../../lib/database.js';
import { initDatabase } from './db.js';
import { initLogger } from './logger.js';
import { runOnceForDate } from './run-once.js';
import { yesterdayInSaoPaulo } from './scheduler.js';

/**
 * Gera o relatório diário de cada tenant ativo. Roda diariamente às 06:00 BRT
 * (cron `0 6 * * *` America/Sao_Paulo) e relata o dia anterior — janela
 * fechada de 00:00–23:59 BRT do dia previous.
 *
 * Idempotente: `daily_tenant_reports` tem UNIQUE(tenant_id, report_date) e o
 * pipeline pula tenants que já têm row 'completed' (a menos que --force, mas
 * o daemon nunca força). Seguro rodar em paralelo com o cron do Mac durante
 * a migração — o segundo run vira no-op.
 *
 * Adapter pattern: o módulo `db.ts`/`logger.ts` desta pasta expõem APIs
 * compatíveis com o script original (`desenrolaPool.query()`, `logger.info()`)
 * mas delegam pro `Database`/`Logger` injetados aqui. Init no início do `run()`.
 */
@injectable()
export class DailyReportsJob extends Job {
  readonly name = 'daily-reports';
  readonly displayName = 'Relatórios Diários para Clientes';
  readonly description =
    'Toda manhã às 6h, gera um relatório personalizado pra cada cliente ativo ' +
    'sobre o atendimento do dia anterior — volume, conversões, leitura ' +
    'qualitativa das conversas. Fica disponível em /relatorios-diarios pra ' +
    'envio manual.';
  readonly schedule = '0 6 * * *';

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.Database) private readonly db: Database,
  ) {
    super();
  }

  async run(): Promise<void> {
    initDatabase(this.db);
    initLogger(this.logger.child({ job: this.name }));

    const reportDate = yesterdayInSaoPaulo();
    await runOnceForDate(reportDate);
  }
}
