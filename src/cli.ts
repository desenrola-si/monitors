import 'reflect-metadata';
import 'dotenv/config';
import { buildContainer } from './lib/container.js';
import { getAllJobs, getJobByName } from './jobs/index.js';
import { TYPES } from './lib/types.js';
import { Logger } from './lib/logger.js';
import { Database } from './lib/database.js';

/**
 * CLI one-shot. Uso:
 *   tsx src/cli.ts --list             → lista jobs disponíveis
 *   tsx src/cli.ts <nome-do-job>      → roda 1 job e sai
 *
 * Modo recomendado pra Railway cron jobs (1 service por cron, agendado
 * externamente). Sobe container, executa, encerra com exit code 0 ou 1.
 */
async function main(): Promise<void> {
  const container = buildContainer();
  const logger = container.get<Logger>(TYPES.Logger);
  const db = container.get<Database>(TYPES.Database);

  const arg = process.argv[2];

  if (!arg || arg === '--list' || arg === '-l') {
    const jobs = getAllJobs(container);
    console.log('Jobs disponíveis:');
    for (const j of jobs) {
      console.log(
        `  ${j.name.padEnd(28)} ${j.schedule.padEnd(14)} ${j.description}`,
      );
    }
    await db.close();
    process.exit(arg ? 0 : 1);
  }

  const job = getJobByName(container, arg);
  if (!job) {
    logger.error({ arg }, `Job desconhecido. Use --list pra ver os disponíveis.`);
    await db.close();
    process.exit(1);
  }

  const t0 = Date.now();
  logger.info({ job: job.name }, 'Job iniciando (CLI)');
  try {
    await job.run();
    logger.info({ job: job.name, ms: Date.now() - t0 }, 'Job concluído');
    await db.close();
    process.exit(0);
  } catch (err) {
    logger.error(
      { job: job.name, err: (err as Error).message, ms: Date.now() - t0 },
      'Job falhou',
    );
    await db.close();
    process.exit(1);
  }
}

main();
