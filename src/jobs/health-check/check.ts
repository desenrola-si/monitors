import { Database } from '../../lib/database.js';
import { Logger } from '../../lib/logger.js';
import { AlertTypeCode } from '../../lib/repositories/alerts-repository.js';
import { FindingSeverity } from '../../lib/repositories/health-check-repository.js';

/**
 * Resultado de um check para um tenant problemático.
 */
export interface CheckResult {
  tenantId: string;
  tenantName: string | null;
  severity: FindingSeverity;
  metricValue: number | null;
  payload: Record<string, unknown>;
  /** Mensagem amigável que vai pro Google Chat e pro alert */
  notificationText: string;
}

export interface CheckContext {
  db: Database;
  log: Logger;
}

/**
 * Cada check verifica UMA condição específica em todos os tenants ativos
 * via 1 query agregada (GROUP BY tenant_id) — não topa o banco e roda
 * em < 1s.
 *
 * Convenção: retorna lista de tenants COM problema. Quem some da lista
 * entre runs consecutivos é considerado auto-resolvido pelo HealthCheckJob.
 */
export interface Check {
  readonly code: string;
  readonly alertTypeCode: AlertTypeCode;
  readonly description: string;
  run(ctx: CheckContext): Promise<CheckResult[]>;
}
