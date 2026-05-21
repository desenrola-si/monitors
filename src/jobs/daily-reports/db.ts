import { QueryResultRow } from 'pg';
import { Database } from '../../lib/database.js';

let _db: Database | null = null;

export function initDatabase(database: Database): void {
  _db = database;
}

function ensure(): Database {
  if (!_db) {
    throw new Error('daily-reports db não inicializado — chame initDatabase() antes de usar');
  }
  return _db;
}

interface PoolLike {
  query: <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[] }>;
}

export const desenrolaPool: PoolLike = {
  query: async <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ) => {
    const rows = await ensure().query<T>(sql, params, 'desenrola');
    return { rows };
  },
};

export const workflowPool: PoolLike = {
  query: async <T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ) => {
    const rows = await ensure().query<T>(sql, params, 'workflow_processor');
    return { rows };
  },
};

export async function closePools(): Promise<void> {
  // No-op — Database é dono dos pools e fecha no shutdown do daemon.
}
