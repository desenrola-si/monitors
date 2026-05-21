import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import secureSession from '@fastify/secure-session';

declare module '@fastify/secure-session' {
  interface SessionData {
    user?: { username: string };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Registra @fastify/secure-session com cookie httpOnly assinado/criptografado
 * server-side. Expõe `requireAuth` como preHandler reutilizável.
 *
 * Sem session store externo — secure-session embute o payload no cookie cifrado.
 * Single-user, então não precisa lookup. Key vem de SESSION_KEY (32 bytes hex).
 */
const authPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const keyHex = process.env.SESSION_KEY;
  if (!keyHex) {
    throw new Error(
      'SESSION_KEY não configurada. Gere com `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"` e adicione no env.',
    );
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(`SESSION_KEY deve ter 32 bytes (64 hex chars), recebeu ${key.length}`);
  }

  await fastify.register(secureSession, {
    key,
    cookieName: 'monitors_session',
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 30, // 30 dias
    },
  });

  fastify.decorate(
    'requireAuth',
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const user = req.session.get('user');
      if (!user) {
        await reply.code(401).send({ error: 'unauthorized' });
      }
    },
  );
};

export default fp(authPlugin, { name: 'auth' });
