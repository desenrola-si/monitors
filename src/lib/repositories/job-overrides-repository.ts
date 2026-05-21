import { injectable, inject } from 'inversify';
import { TYPES } from '../types.js';
import { Database } from '../database.js';

export interface JobOverrideRow {
  jobName: string;
  scheduleOverride: string;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Repository pra overrides de schedule por job. Daemon lê todos no boot e
 * aplica em cima do schedule default. Update via UI persiste aqui e dispara
 * reload do task no daemon.
 */
@injectable()
export class JobOverridesRepository {
  constructor(@inject(TYPES.Database) private readonly db: Database) {}

  async listAll(): Promise<JobOverrideRow[]> {
    const rows = await this.db.query<{
      job_name: string;
      schedule_override: string;
      updated_at: string;
      updated_by: string | null;
    }>(
      `SELECT job_name, schedule_override,
              TO_CHAR(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
              updated_by
       FROM job_overrides`,
      [],
      'monitors',
    );
    return rows.map((r) => ({
      jobName: r.job_name,
      scheduleOverride: r.schedule_override,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    }));
  }

  async upsert(
    jobName: string,
    scheduleOverride: string,
    updatedBy: string,
  ): Promise<void> {
    await this.db.query(
      `
      INSERT INTO job_overrides (job_name, schedule_override, updated_by, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (job_name) DO UPDATE SET
        schedule_override = EXCLUDED.schedule_override,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      `,
      [jobName, scheduleOverride, updatedBy],
      'monitors',
    );
  }

  async delete(jobName: string): Promise<void> {
    await this.db.query(
      `DELETE FROM job_overrides WHERE job_name = $1`,
      [jobName],
      'monitors',
    );
  }
}
