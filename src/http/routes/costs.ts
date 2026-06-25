import { FastifyPluginAsync } from 'fastify';
import { Container } from 'inversify';
import { TYPES } from '../../lib/types.js';
import { CostRepository } from '../../lib/repositories/cost-repository.js';

interface CostsRoutesOpts {
  container: Container;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function defaultFrom(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 29);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const costsRoutes: (opts: CostsRoutesOpts) => FastifyPluginAsync =
  ({ container }) =>
  async (fastify) => {
    const costRepo = container.get<CostRepository>(TYPES.CostRepository);

    fastify.addHook('preHandler', fastify.requireAuth);

    fastify.get<{ Querystring: { from?: string; to?: string } }>(
      '/api/costs',
      async (req, reply) => {
        const from = req.query.from ?? defaultFrom();
        const to = req.query.to ?? today();

        if (!DATE.test(from) || !DATE.test(to)) {
          return reply.code(400).send({ error: 'invalid_date', message: 'use YYYY-MM-DD' });
        }
        if (from > to) {
          return reply.code(400).send({ error: 'invalid_range', message: 'from > to' });
        }

        const breakdown = await costRepo.getBreakdown(from, to);
        return reply.send(breakdown);
      },
    );
  };

export default costsRoutes;
