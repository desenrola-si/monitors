import { injectable, inject } from 'inversify';
import { TYPES } from '../types.js';
import { Database } from '../database.js';
import { JobLogLevel } from '../job-events.js';

export interface JobLogRow {
  id: string;
  jobName: string;
  jobRunId: string | null;
  level: JobLogLevel;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export interface InsertJobLogArgs {
  jobName: string;
  jobRunId?: string | null;
  level: JobLogLevel;
  message: string;
  data?: Record<string, unknown> | null;
  /** Timestamp do log no momento em que foi emitido. Default: NOW(). */
  createdAt?: string;
}

@injectable()
export class JobLogsRepository {
  constructor(@inject(TYPES.Database) private readonly db: Database) {}

  async insert(args: InsertJobLogArgs): Promise<void> {
    await this.db.query(
      `
      INSERT INTO job_logs (job_name, job_run_id, level, message, data, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6::timestamp, NOW()))
      `,
      [
        args.jobName,
        args.jobRunId ?? null,
        args.level,
        args.message,
        args.data ? JSON.stringify(args.data) : null,
        args.createdAt ?? null,
      ],
      'monitors',
    );
  }

  async listByJob(
    jobName: string,
    limit = 50,
  ): Promise<JobLogRow[]> {
    const rows = await this.db.query<{
      id: string;
      job_name: string;
      job_run_id: string | null;
      level: JobLogLevel;
      message: string;
      data: Record<string, unknown> | null;
      created_at: string;
    }>(
      `
      SELECT
        id::text AS id,
        job_name,
        job_run_id::text AS job_run_id,
        level,
        message,
        data,
        TO_CHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM job_logs
      WHERE job_name = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
      `,
      [jobName, limit],
      'monitors',
    );
    // Reverte pra ordem cronológica ascendente (mais antiga primeiro)
    return rows.reverse().map((r) => ({
      id: r.id,
      jobName: r.job_name,
      jobRunId: r.job_run_id,
      level: r.level,
      message: r.message,
      data: r.data,
      createdAt: r.created_at,
    }));
  }
}
