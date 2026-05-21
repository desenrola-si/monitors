import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyFormbody from '@fastify/formbody';
import { Container } from 'inversify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.js';
import jobsRoutes, { JobRunSummary } from './routes/jobs.js';
import streamRoutes from './routes/stream.js';
import { TYPES } from '../lib/types.js';
import { JobEvents } from '../lib/job-events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface HttpServerOpts {
  container: Container;
  lastRunByJob: Map<string, JobRunSummary>;
  /** Map jobName → schedule corrente (default ou override). Atualizado em reload. */
  effectiveSchedules: Map<string, string>;
  triggerNow: (jobName: string) => Promise<void>;
  reloadSchedule: (
    jobName: string,
    newSchedule: string,
    actor: string,
  ) => Promise<void>;
}

/**
 * Cria a instância Fastify do dashboard. Roda lado-a-lado do daemon de cron
 * no mesmo processo Railway — mesma porta (PORT injetada pelo Railway).
 *
 * Pipeline de request:
 *   1. preHandler global em /api/* — exige session via plugin auth
 *   2. POST /login emite session cookie
 *   3. GET /api/* (jobs, runs) requer session
 *   4. GET / e /assets/* servem o build Svelte (frontend/dist)
 *
 * Em dev (NODE_ENV !== 'production'), o usuário deve rodar Vite em :5173 com
 * proxy /api → :PORT. Fastify continua servindo build se existir mas o dev
 * server do Vite tem hot reload.
 */
export async function buildHttpServer(opts: HttpServerOpts): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
  });

  await fastify.register(fastifyFormbody);
  await fastify.register(authPlugin);

  await fastify.register(authRoutes);
  await fastify.register(
    jobsRoutes({
      container: opts.container,
      lastRunByJob: opts.lastRunByJob,
      effectiveSchedules: opts.effectiveSchedules,
      triggerNow: opts.triggerNow,
      reloadSchedule: opts.reloadSchedule,
    }),
  );

  const jobEvents = opts.container.get<JobEvents>(TYPES.JobEvents);
  await fastify.register(streamRoutes({ jobEvents }));

  // Serve build do Svelte em prod. Path: frontend/dist relativo à raiz do repo.
  // Quando rodando do `dist/http/server.js`, raiz fica 3 níveis acima.
  const frontendDist = path.resolve(__dirname, '../../frontend/dist');
  await fastify.register(fastifyStatic, {
    root: frontendDist,
    prefix: '/',
    decorateReply: false,
  });

  // SPA fallback — qualquer GET fora de /api ou /login devolve index.html
  // pro client-side router lidar.
  fastify.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api') || req.url === '/login') {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });

  return fastify;
}
