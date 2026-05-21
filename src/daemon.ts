import 'reflect-metadata';
import 'dotenv/config';
import cron from 'node-cron';
import { buildContainer } from './lib/container.js';
import { getAllJobs } from './jobs/index.js';
import { TYPES } from './lib/types.js';
import { Logger } from './lib/logger.js';
import { Database } from './lib/database.js';

/**
 * Daemon que registra todos os jobs no node-cron e fica vivo até SIGTERM.
 * Modo recomendado pra Railway service sempre-on (1 service com vários
 * crons internos, dashboard único, mais barato pra muitos jobs).
 *
 * Cuidados:
 * - Cada job tem timezone próprio (default America/Sao_Paulo)
 * - Set `running` previne overlap: se job N ainda rodando, próxima execução skip
 * - Erros do job NÃO matam o daemon (try/catch interno)
 * - SIGTERM: aguarda jobs em andamento por 30s, fecha pools, sai
 */

const container = buildContainer();
const logger = container.get<Logger>(TYPES.Logger);
const db = container.get<Database>(TYPES.Database);
const jobs = getAllJobs(container);

const running = new Set<string>();

logger.info({ count: jobs.length }, 'Daemon iniciando');

for (const job of jobs) {
  if (!cron.validate(job.schedule)) {
    logger.error(
      { job: job.name, schedule: job.schedule },
      'Schedule inválido, daemon abortando',
    );
    process.exit(1);
  }

  cron.schedule(
    job.schedule,
    async () => {
      if (running.has(job.name)) {
        logger.warn(
          { job: job.name },
          'Skip — execução anterior ainda em andamento',
        );
        return;
      }
      running.add(job.name);
      const t0 = Date.now();
      logger.info({ job: job.name }, 'Job iniciando');
      try {
        await job.run();
        logger.info(
          { job: job.name, ms: Date.now() - t0 },
          'Job concluído',
        );
      } catch (err) {
        logger.error(
          {
            job: job.name,
            err,
            ms: Date.now() - t0,
          },
          'Job falhou (daemon continua)',
        );
      } finally {
        running.delete(job.name);
      }
    },
    { timezone: job.timezone },
  );

  logger.info(
    { job: job.name, schedule: job.schedule, timezone: job.timezone },
    'Job registrado',
  );
}

logger.info('Daemon pronto, aguardando schedules');

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'Shutdown recebido — aguardando jobs (max 30s)');
  const deadline = Date.now() + 30_000;
  while (running.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (running.size > 0) {
    logger.warn({ jobs: [...running] }, 'Encerrando com jobs ainda em andamento');
  }
  await db.close();
  logger.info('Shutdown concluído');
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
