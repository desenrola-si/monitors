import { FastifyPluginAsync } from 'fastify';
import { Container } from 'inversify';
import { getAllJobs, getJobByName } from '../../jobs/index.js';
import { Job } from '../../lib/job.js';
import { TYPES } from '../../lib/types.js';
import { JobRunsRepository } from '../../lib/repositories/job-runs-repository.js';

interface JobsRoutesOpts {
  container: Container;
  /**
   * Cache in-memory de last-run pra resposta rápida do GET /api/jobs sem hit
   * no DB. Daemon atualiza em todo finally. Histórico completo vem do DB
   * (job_runs) via JobRunsRepository.
   */
  lastRunByJob: Map<string, JobRunSummary>;
  /** Schedule corrente por job (default ou override aplicado). */
  effectiveSchedules: Map<string, string>;
  /** Dispara job imediatamente (fora do schedule). */
  triggerNow: (jobName: string) => Promise<void>;
  /** Persiste override em job_overrides + recarrega task no node-cron. */
  reloadSchedule: (
    jobName: string,
    newSchedule: string,
    actor: string,
  ) => Promise<void>;
}

export interface JobRunSummary {
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'success' | 'failed';
  durationMs: number | null;
  errorMessage: string | null;
}

const jobsRoutes: (opts: JobsRoutesOpts) => FastifyPluginAsync =
  ({ container, lastRunByJob, effectiveSchedules, triggerNow, reloadSchedule }) =>
  async (fastify) => {
    const jobRunsRepo = container.get<JobRunsRepository>(
      TYPES.JobRunsRepository,
    );

    fastify.addHook('preHandler', fastify.requireAuth);

    fastify.get('/api/jobs', async () => {
      const jobs: Job[] = getAllJobs(container);
      return {
        jobs: jobs.map((j) => {
          const effective = effectiveSchedules.get(j.name) ?? j.schedule;
          return {
            name: j.name,
            displayName: j.displayName ?? null,
            description: j.description,
            schedule: effective,
            scheduleDefault: j.schedule,
            scheduleIsOverridden: effective !== j.schedule,
            timezone: j.timezone,
            lastRun: lastRunByJob.get(j.name) ?? null,
          };
        }),
      };
    });

    fastify.post<{ Params: { name: string } }>(
      '/api/jobs/:name/trigger',
      async (req, reply) => {
        const job = getJobByName(container, req.params.name);
        if (!job) {
          return reply.code(404).send({ error: 'job_not_found' });
        }
        void triggerNow(req.params.name).catch((err) => {
          fastify.log.error({ err, job: req.params.name }, 'trigger falhou');
        });
        return reply.send({ ok: true, triggered: req.params.name });
      },
    );

    fastify.put<{
      Params: { name: string };
      Body: { schedule: string };
    }>('/api/jobs/:name/schedule', {
      schema: {
        body: {
          type: 'object',
          required: ['schedule'],
          properties: {
            schedule: { type: 'string', minLength: 5, maxLength: 120 },
          },
        },
      },
      handler: async (req, reply) => {
        const job = getJobByName(container, req.params.name);
        if (!job) {
          return reply.code(404).send({ error: 'job_not_found' });
        }
        const actor = req.session.get('user')?.username ?? 'unknown';
        try {
          await reloadSchedule(req.params.name, req.body.schedule.trim(), actor);
          return reply.send({
            ok: true,
            schedule: effectiveSchedules.get(req.params.name),
          });
        } catch (err) {
          return reply.code(400).send({
            error: 'invalid_schedule',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    fastify.get<{
      Params: { name: string };
      Querystring: { limit?: string; offset?: string };
    }>('/api/jobs/:name/runs', async (req, reply) => {
      const job = getJobByName(container, req.params.name);
      if (!job) {
        return reply.code(404).send({ error: 'job_not_found' });
      }
      const limit = Math.min(
        parseInt(req.query.limit ?? '50', 10) || 50,
        200,
      );
      const offset = parseInt(req.query.offset ?? '0', 10) || 0;
      try {
        const rows = await jobRunsRepo.listByJob(req.params.name, limit, offset);
        return reply.send({
          runs: rows.map((r) => ({
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            status: r.statusCode,
            durationMs: r.durationMs,
            errorMessage: r.errorMessage,
            triggerSource: r.triggerSource,
          })),
        });
      } catch (err) {
        // Fallback pro cache in-memory se DB não estiver acessível
        fastify.log.warn(
          { err, job: req.params.name },
          'job_runs DB unavailable, falling back to in-memory',
        );
        const last = lastRunByJob.get(req.params.name);
        return reply.send({ runs: last ? [last] : [] });
      }
    });
  };

export default jobsRoutes;
