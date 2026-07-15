import { injectable, inject } from 'inversify';
import { Pool, QueryResultRow } from 'pg';
import { TYPES, DbName } from './types.js';
import { Logger } from './logger.js';

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ENETUNREACH',
  'ECONNREFUSED',
  'EAI_AGAIN',
]);

function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  // pg-pool agrega múltiplas tentativas DNS num AggregateError — checa erros internos
  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.some((e) => isTransientError(e))) {
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Cliente Postgres com lazy pools por DB. Sem ORM — queries diretas.
 * Jobs chamam `db.query<RowType>(sql, params)` ou `db.query(sql, params, 'workflow_processor')`.
 *
 * Retry: 1 tentativa adicional em erros transitórios de rede (ETIMEDOUT,
 * ECONNRESET, etc) com backoff de 1s. Útil pra cold start do pool e
 * glitches transitórios entre Railway e Hostinger.
 */
@injectable()
export class Database {
  private readonly pools = new Map<DbName, Pool>();
  private static readonly RETRY_BACKOFF_MS = 1_000;

  constructor(@inject(TYPES.Logger) private readonly logger: Logger) {}

  private pool(name: DbName): Pool {
    const existing = this.pools.get(name);
    if (existing) return existing;

    const envKey =
      name === 'desenrola'
        ? 'DESENROLA_DB_URL'
        : name === 'workflow_processor'
          ? 'WORKFLOW_PROCESSOR_DB_URL'
          : 'MONITORS_DB_URL';
    const url = process.env[envKey];
    if (!url) {
      throw new Error(`Variável de ambiente ${envKey} não configurada`);
    }

    const pool = new Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 60_000,
    });
    pool.on('error', (err) =>
      this.logger.error({ err: err.message, db: name }, 'pg pool error'),
    );
    this.pools.set(name, pool);
    return pool;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
    db: DbName = 'desenrola',
  ): Promise<T[]> {
    try {
      const result = await this.pool(db).query<T>(sql, params as never);
      return result.rows;
    } catch (err) {
      if (!isTransientError(err)) throw err;
      this.logger.warn(
        { db, err: (err as Error).message || 'transient pg error' },
        'Query falhou com erro transitório — tentando 1 retry em 1s',
      );
      await sleep(Database.RETRY_BACKOFF_MS);
      const result = await this.pool(db).query<T>(sql, params as never);
      return result.rows;
    }
  }

  async close(): Promise<void> {
    for (const [name, pool] of this.pools.entries()) {
      try {
        await pool.end();
      } catch (err) {
        this.logger.warn({ db: name, err: (err as Error).message }, 'erro ao fechar pool');
      }
    }
    this.pools.clear();
  }
}
