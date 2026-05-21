// Log síncrono ANTES de qualquer import — sinal de vida bruto. Se algo
// quebrar no boot (DI, env, pino), pelo menos esse stdout aparece.
// eslint-disable-next-line no-console
console.log(`[boot] daemon starting pid=${process.pid} node=${process.version} env=${process.env.NODE_ENV ?? 'undefined'}`);

import 'reflect-metadata';
import 'dotenv/config';
import cron from 'node-cron';
import { buildContainer } from './lib/container.js';
import { getAllJobs, getJobByName } from './jobs/index.js';
import { TYPES } from './lib/types.js';
import { Logger } from './lib/logger.js';
import { Database } from './lib/database.js';
import { Job } from './lib/job.js';
import { buildHttpServer } from './http/server.js';
import { JobRunSummary } from './http/routes/jobs.js';
import { JobRunsRepository } from './lib/repositories/job-runs-repository.js';
import { JobOverridesRepository } from './lib/repositories/job-overrides-repository.js';
import { JobEvents } from './lib/job-events.js';
import type { ScheduledTask } from 'node-cron';

// eslint-disable-next-line no-console
console.log(`[boot] imports loaded, building container`);

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
 *
 * Inclui também HTTP server (Fastify) lado-a-lado pro dashboard.
 */

const container = buildContainer();
const logger = container.get<Logger>(TYPES.Logger);
const db = container.get<Database>(TYPES.Database);
const jobRunsRepo = container.get<JobRunsRepository>(TYPES.JobRunsRepository);
const jobOverridesRepo = container.get<JobOverridesRepository>(
  TYPES.JobOverridesRepository,
);
const jobEvents = container.get<JobEvents>(TYPES.JobEvents);
const jobs = getAllJobs(container);

const running = new Set<string>();
const lastRunByJob = new Map<string, JobRunSummary>();
const scheduledTasks = new Map<string, ScheduledTask>();
const effectiveSchedules = new Map<string, string>();

/**
 * Executa um job com tracking em 3 camadas:
 *   - `running` Set: dedup de execução concorrente
 *   - `lastRunByJob` Map: cache in-memory pro GET /api/jobs responder rápido
 *   - `job_runs` table: histórico persistente pro dashboard (pode falhar sem
 *     derrubar o job — só loga warning)
 *
 * Compartilhado entre o scheduler do cron e o `triggerNow` exposto via HTTP.
 */
async function runJob(job: Job, source: 'cron' | 'manual'): Promise<void> {
  if (running.has(job.name)) {
    logger.warn(
      { job: job.name, source },
      'Skip — execução anterior ainda em andamento',
    );
    return;
  }
  running.add(job.name);
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const t0 = Date.now();
  lastRunByJob.set(job.name, {
    startedAt,
    finishedAt: null,
    status: 'running',
    durationMs: null,
    errorMessage: null,
  });

  let runId: string | null = null;
  try {
    runId = await jobRunsRepo.insertRunning(job.name, source, startedAtDate);
  } catch (err) {
    logger.warn(
      { job: job.name, err: (err as Error).message },
      'Falha ao persistir job_runs (running) — daemon continua',
    );
  }

  logger.info({ job: job.name, source }, 'Job iniciando');
  jobEvents.emit({
    type: 'job.started',
    name: job.name,
    startedAt,
    source,
  });
  try {
    await job.run();
    const durationMs = Date.now() - t0;
    const finishedAt = new Date();
    lastRunByJob.set(job.name, {
      startedAt,
      finishedAt: finishedAt.toISOString(),
      status: 'success',
      durationMs,
      errorMessage: null,
    });
    if (runId) {
      await jobRunsRepo
        .markFinished(runId, {
          statusCode: 'success',
          finishedAt,
          durationMs,
        })
        .catch((err: Error) =>
          logger.warn(
            { job: job.name, err: err.message },
            'Falha ao persistir job_runs (success)',
          ),
        );
    }
    jobEvents.emit({
      type: 'job.finished',
      name: job.name,
      status: 'success',
      startedAt,
      finishedAt: finishedAt.toISOString(),
      durationMs,
      errorMessage: null,
    });
    logger.info({ job: job.name, ms: durationMs }, 'Job concluído');
  } catch (err) {
    const durationMs = Date.now() - t0;
    const finishedAt = new Date();
    const errorMessage = err instanceof Error ? err.message : String(err);
    lastRunByJob.set(job.name, {
      startedAt,
      finishedAt: finishedAt.toISOString(),
      status: 'failed',
      durationMs,
      errorMessage,
    });
    if (runId) {
      await jobRunsRepo
        .markFinished(runId, {
          statusCode: 'failed',
          finishedAt,
          durationMs,
          errorMessage,
        })
        .catch((persistErr: Error) =>
          logger.warn(
            { job: job.name, err: persistErr.message },
            'Falha ao persistir job_runs (failed)',
          ),
        );
    }
    jobEvents.emit({
      type: 'job.finished',
      name: job.name,
      status: 'failed',
      startedAt,
      finishedAt: finishedAt.toISOString(),
      durationMs,
      errorMessage,
    });
    logger.error(
      { job: job.name, err, ms: durationMs },
      'Job falhou (daemon continua)',
    );
  } finally {
    running.delete(job.name);
  }
}

/**
 * Aplica um schedule pra um job — destrói task anterior se houver e cria um
 * novo. Usado tanto no boot quanto no reload via API.
 */
function applySchedule(job: Job, schedule: string): void {
  const existing = scheduledTasks.get(job.name);
  if (existing) {
    existing.stop();
    scheduledTasks.delete(job.name);
  }
  const task = cron.schedule(schedule, () => void runJob(job, 'cron'), {
    timezone: job.timezone,
  });
  scheduledTasks.set(job.name, task);
  effectiveSchedules.set(job.name, schedule);
}

async function bootScheduler(): Promise<void> {
  let overrides: Awaited<ReturnType<typeof jobOverridesRepo.listAll>> = [];
  try {
    overrides = await jobOverridesRepo.listAll();
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'Falha ao ler job_overrides — usando schedules default',
    );
  }
  const overrideByName = new Map(overrides.map((o) => [o.jobName, o.scheduleOverride]));

  // Popula cache in-memory de lastRun com a última execução de cada job do DB.
  // Sem isso, após redeploy o dashboard mostra "nunca rodou" até o próximo tick.
  for (const job of jobs) {
    try {
      const last = await jobRunsRepo.findLastByJob(job.name);
      if (last) {
        lastRunByJob.set(job.name, {
          startedAt: last.startedAt,
          finishedAt: last.finishedAt,
          status: last.statusCode,
          durationMs: last.durationMs,
          errorMessage: last.errorMessage,
        });
      }
    } catch (err) {
      logger.warn(
        { job: job.name, err: (err as Error).message },
        'Falha ao popular lastRun do DB — cache vazio até próximo tick',
      );
    }
  }

  logger.info({ count: jobs.length }, 'Daemon iniciando');

  for (const job of jobs) {
    const schedule = overrideByName.get(job.name) ?? job.schedule;
    if (!cron.validate(schedule)) {
      logger.error(
        { job: job.name, schedule },
        'Schedule inválido, daemon abortando',
      );
      process.exit(1);
    }

    applySchedule(job, schedule);
    const isOverride = schedule !== job.schedule;
    logger.info(
      { job: job.name, schedule, timezone: job.timezone, override: isOverride },
      'Job registrado',
    );
  }

  logger.info('Daemon pronto, aguardando schedules');
}

void bootScheduler();

// HTTP server (dashboard + API). Falha silenciosa se SESSION_KEY não estiver
// configurado — daemon de cron continua. Útil pra rodar daemon dev sem
// configurar tudo do http.
let httpServer: Awaited<ReturnType<typeof buildHttpServer>> | null = null;

async function startHttpServer(): Promise<void> {
  try {
    const port = Number(process.env.PORT ?? 3000);
    httpServer = await buildHttpServer({
      container,
      lastRunByJob,
      effectiveSchedules,
      triggerNow: async (jobName: string): Promise<void> => {
        const job = getJobByName(container, jobName);
        if (!job) {
          throw new Error(`Job não encontrado: ${jobName}`);
        }
        await runJob(job, 'manual');
      },
      reloadSchedule: async (
        jobName: string,
        newSchedule: string,
        actor: string,
      ): Promise<void> => {
        const job = getJobByName(container, jobName);
        if (!job) {
          throw new Error(`Job não encontrado: ${jobName}`);
        }
        if (!cron.validate(newSchedule)) {
          throw new Error(`Schedule inválido: ${newSchedule}`);
        }
        // Se o novo schedule bate com o default, apaga o override
        if (newSchedule === job.schedule) {
          await jobOverridesRepo.delete(jobName);
        } else {
          await jobOverridesRepo.upsert(jobName, newSchedule, actor);
        }
        applySchedule(job, newSchedule);
        jobEvents.emit({
          type: 'job.scheduled',
          name: jobName,
          schedule: newSchedule,
          scheduleDefault: job.schedule,
          isOverride: newSchedule !== job.schedule,
        });
        logger.info(
          { job: jobName, newSchedule, actor },
          'Schedule recarregado',
        );
      },
    });
    await httpServer.listen({ port, host: '0.0.0.0' });
    logger.info({ port }, 'HTTP server pronto');
  } catch (err) {
    logger.error({ err }, 'HTTP server falhou ao subir — daemon continua só com crons');
  }
}

void startHttpServer();

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'Shutdown recebido — aguardando jobs (max 30s)');
  const deadline = Date.now() + 30_000;
  while (running.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (running.size > 0) {
    logger.warn({ jobs: [...running] }, 'Encerrando com jobs ainda em andamento');
  }
  if (httpServer) {
    await httpServer.close().catch(() => undefined);
  }
  for (const task of scheduledTasks.values()) {
    task.stop();
  }
  scheduledTasks.clear();
  await db.close();
  logger.info('Shutdown concluído');
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
