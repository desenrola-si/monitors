import 'reflect-metadata';
import { Container } from 'inversify';
import { TYPES } from './types.js';
import { Logger } from './logger.js';
import { Database } from './database.js';
import { Notifier } from './notifier.js';
import { AlertsRepository } from './repositories/alerts-repository.js';
import { JobRunsRepository } from './repositories/job-runs-repository.js';
import { JobOverridesRepository } from './repositories/job-overrides-repository.js';
import { JobLogsRepository } from './repositories/job-logs-repository.js';
import { HealthCheckRepository } from './repositories/health-check-repository.js';
import { JobEvents } from './job-events.js';
import { registerJobs } from '../jobs/index.js';

/**
 * Constrói o container Inversify com todos os bindings. Chamado pelo
 * cli.ts (one-shot) e pelo daemon.ts (sempre on) — mesmo container.
 */
export function buildContainer(): Container {
  const container = new Container({ defaultScope: 'Singleton' });

  container.bind<Logger>(TYPES.Logger).to(Logger);
  container.bind<Database>(TYPES.Database).to(Database);
  container.bind<Notifier>(TYPES.Notifier).to(Notifier);
  container.bind<AlertsRepository>(TYPES.AlertsRepository).to(AlertsRepository);
  container.bind<JobRunsRepository>(TYPES.JobRunsRepository).to(JobRunsRepository);
  container.bind<JobOverridesRepository>(TYPES.JobOverridesRepository).to(JobOverridesRepository);
  container.bind<JobLogsRepository>(TYPES.JobLogsRepository).to(JobLogsRepository);
  container.bind<HealthCheckRepository>(TYPES.HealthCheckRepository).to(HealthCheckRepository);
  container.bind<JobEvents>(TYPES.JobEvents).to(JobEvents);

  registerJobs(container);

  return container;
}
