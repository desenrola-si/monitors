import { FastifyPluginAsync } from 'fastify';
import { JobEvents, JobEvent } from '../../lib/job-events.js';

interface StreamRoutesOpts {
  jobEvents: JobEvents;
}

/**
 * Rota SSE pra updates de jobs em tempo real.
 *
 * GET /api/jobs/stream (autenticado via session)
 *   → mantém conexão aberta, emite cada evento como SSE message
 *   → heartbeat a cada 30s (comentário `:` keepalive) pra proxies não fecharem
 *   → frontend usa EventSource (reconexão automática built-in)
 *
 * Não usa Fastify reply normal — escreve direto no raw stream pra controlar
 * headers e flush em tempo real.
 */
const streamRoutes: (opts: StreamRoutesOpts) => FastifyPluginAsync =
  ({ jobEvents }) =>
  async (fastify) => {
    fastify.get('/api/jobs/stream', {
      preHandler: fastify.requireAuth,
      handler: async (req, reply) => {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          // Disable nginx/Cloudflare buffering pra streaming real-time
          'X-Accel-Buffering': 'no',
        });

        // Hello inicial pro cliente saber que tá conectado
        reply.raw.write(`: connected ${new Date().toISOString()}\n\n`);

        const send = (event: JobEvent): void => {
          try {
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {
            // Conexão pode ter morrido entre o emit e o write — ignore.
          }
        };

        jobEvents.on(send);

        const keepalive = setInterval(() => {
          try {
            reply.raw.write(`: keepalive ${new Date().toISOString()}\n\n`);
          } catch {
            // idem
          }
        }, 30_000);

        // Cleanup: cliente fechou (browser) ou request encerrou
        req.raw.on('close', () => {
          clearInterval(keepalive);
          jobEvents.off(send);
        });

        // Mantém handler vivo até o cliente fechar
        return reply;
      },
    });
  };

export default streamRoutes;
