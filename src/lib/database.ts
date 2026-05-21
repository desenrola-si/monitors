import { injectable, inject } from 'inversify';
import { Pool, QueryResultRow } from 'pg';
import { TYPES, DbName } from './types.js';
import { Logger } from './logger.js';

/**
 * Cliente Postgres com lazy pools por DB. Sem ORM — queries diretas.
 * Jobs chamam `db.query<RowType>(sql, params)` ou `db.query(sql, params, 'workflow_processor')`.
 */
@injectable()
export class Database {
  private readonly pools = new Map<DbName, Pool>();

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
      connectionTimeoutMillis: 10_000,
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
    const result = await this.pool(db).query<T>(sql, params as never);
    return result.rows;
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
