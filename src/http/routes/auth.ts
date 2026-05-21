import { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';

interface LoginBody {
  username: string;
  password: string;
}

/**
 * Single-user auth via env vars:
 *   DASHBOARD_USER         — username em texto claro
 *   DASHBOARD_PASS_HASH    — bcrypt hash da senha (gerar com `bcryptjs.hash(pass, 10)`)
 *
 * POST /login    — body { username, password }, set session
 * POST /logout   — clear session
 * GET  /api/me   — quem está logado (ou 401)
 */
const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: LoginBody }>('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 1 },
          password: { type: 'string', minLength: 1 },
        },
      },
    },
    handler: async (req, reply) => {
      const expectedUser = process.env.DASHBOARD_USER;
      const expectedHash = process.env.DASHBOARD_PASS_HASH;

      if (!expectedUser || !expectedHash) {
        fastify.log.error('DASHBOARD_USER ou DASHBOARD_PASS_HASH não configurados');
        return reply.code(500).send({ error: 'auth_not_configured' });
      }

      const { username, password } = req.body;
      const userOk = username === expectedUser;
      const passOk = await bcrypt.compare(password, expectedHash);

      // Compara sempre os dois pra evitar timing oracle (revelar se user existe)
      if (!userOk || !passOk) {
        return reply.code(401).send({ error: 'invalid_credentials' });
      }

      req.session.set('user', { username });
      return reply.send({ ok: true, user: { username } });
    },
  });

  fastify.post('/logout', async (req, reply) => {
    req.session.delete();
    return reply.send({ ok: true });
  });

  fastify.get('/api/me', async (req, reply) => {
    const user = req.session.get('user');
    if (!user) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return reply.send({ user });
  });
};

export default authRoutes;
