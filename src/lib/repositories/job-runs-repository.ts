import { injectable, inject } from 'inversify';
import { TYPES } from '../types.js';
import { Database } from '../database.js';

export type JobRunStatusCode = 'running' | 'success' | 'failed';
export type JobTriggerSource = 'cron' | 'manual';

export interface JobRunRow {
  id: string;
  jobName: string;
  statusCode: JobRunStatusCode;
  triggerSource: JobTriggerSource;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
}

@injectable()
export class JobRunsRepository {
  constructor(@inject(TYPES.Database) private readonly db: Database) {}

  /**
   * Cria row com status=running e retorna o id pro caller atualizar depois
   * com `markFinished`.
   */
  async insertRunning(
    jobName: string,
    triggerSource: JobTriggerSource,
    startedAt: Date,
  ): Promise<string> {
    const rows = await this.db.query<{ id: string }>(
      `
      INSERT INTO job_runs (job_name, status_id, trigger_source, started_at)
      VALUES (
        $1,
        (SELECT id FROM job_run_statuses WHERE code = 'running'),
        $2,
        $3
      )
      RETURNING id::text AS id
      `,
      [jobName, triggerSource, startedAt.toISOString()],
      'monitors',
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('insertRunning não retornou id');
    return id;
  }

  async markFinished(
    id: string,
    args: {
      statusCode: 'success' | 'failed';
      finishedAt: Date;
      durationMs: number;
      errorMessage?: string | null;
    },
  ): Promise<void> {
    await this.db.query(
      `
      UPDATE job_runs
      SET status_id = (SELECT id FROM job_run_statuses WHERE code = $2),
          finished_at = $3,
          duration_ms = $4,
          error_message = $5
      WHERE id = $1
      `,
      [
        id,
        args.statusCode,
        args.finishedAt.toISOString(),
        args.durationMs,
        args.errorMessage ?? null,
      ],
      'monitors',
    );
  }

  async listByJob(
    jobName: string,
    limit = 50,
    offset = 0,
  ): Promise<JobRunRow[]> {
    const rows = await this.db.query<JobRunRowRaw>(
      `
      SELECT
        r.id::text AS id,
        r.job_name,
        s.code AS status_code,
        r.trigger_source,
        TO_CHAR(r.started_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
        TO_CHAR(r.finished_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS finished_at,
        r.duration_ms,
        r.error_message
      FROM job_runs r
      JOIN job_run_statuses s ON s.id = r.status_id
      WHERE r.job_name = $1
      ORDER BY r.started_at DESC
      LIMIT $2 OFFSET $3
      `,
      [jobName, limit, offset],
      'monitors',
    );
    return rows.map(mapJobRun);
  }

  async findLastByJob(jobName: string): Promise<JobRunRow | null> {
    const rows = await this.listByJob(jobName, 1, 0);
    return rows[0] ?? null;
  }
}

// — internals —

interface JobRunRowRaw {
  id: string;
  job_name: string;
  status_code: JobRunStatusCode;
  trigger_source: JobTriggerSource;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error_message: string | null;
}

function mapJobRun(r: JobRunRowRaw): JobRunRow {
  return {
    id: r.id,
    jobName: r.job_name,
    statusCode: r.status_code,
    triggerSource: r.trigger_source,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    errorMessage: r.error_message,
  };
}
