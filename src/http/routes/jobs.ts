import { FastifyPluginAsync } from 'fastify';
import { Container } from 'inversify';
import { getAllJobs, getJobByName } from '../../jobs/index.js';
import { Job } from '../../lib/job.js';

interface JobsRoutesOpts {
  container: Container;
  /**
   * Map de last-run em memória até a persistência DB chegar. Daemon escreve
   * aqui em todo catch/finally. Quando job_runs estiver pronto, esse map vira
   * só cache pra responder rápido — DB é fonte de verdade pra histórico.
   */
  lastRunByJob: Map<string, JobRunSummary>;
  /**
   * Função que dispara um job imediatamente (fora do schedule). Disponibilizada
   * pelo daemon — encapsula a mesma lógica de overlap-check.
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
        // Não esperamos — dispara assíncrono. Cliente vai ver no GET /api/jobs.
        void triggerNow(req.params.name).catch((err) => {
          fastify.log.error({ err, job: req.params.name }, 'trigger falhou');
        });
        return reply.send({ ok: true, triggered: req.params.name });
      },
    );

    // Placeholder até job_runs estar no DB. Por enquanto retorna só o último.
    fastify.get<{ Params: { name: string } }>(
      '/api/jobs/:name/runs',
      async (req, reply) => {
        const job = getJobByName(container, req.params.name);
        if (!job) {
          return reply.code(404).send({ error: 'job_not_found' });
        }
        const last = lastRunByJob.get(req.params.name);
        return reply.send({ runs: last ? [last] : [] });
      },
    );
  };

export default jobsRoutes;
