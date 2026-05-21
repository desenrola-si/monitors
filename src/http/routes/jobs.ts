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
  /**
   * Função que dispara um job imediatamente (fora do schedule).
   */
  triggerNow: (jobName: string) => Promise<void>;
}

export interface JobRunSummary {
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'success' | 'failed';
  durationMs: number | null;
  errorMessage: string | null;
}

const jobsRoutes: (opts: JobsRoutesOpts) => FastifyPluginAsync =
  ({ container, lastRunByJob, triggerNow }) =>
  async (fastify) => {
    const jobRunsRepo = container.get<JobRunsRepository>(
      TYPES.JobRunsRepository,
    );

    fastify.addHook('preHandler', fastify.requireAuth);

    fastify.get('/api/jobs', async () => {
      const jobs: Job[] = getAllJobs(container);
      return {
        jobs: jobs.map((j) => ({
          name: j.name,
          description: j.description,
          schedule: j.schedule,
          timezone: j.timezone,
          lastRun: lastRunByJob.get(j.name) ?? null,
        })),
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
