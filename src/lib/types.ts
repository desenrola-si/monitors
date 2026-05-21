/**
 * Symbols pro container Inversify. Centralizados pra evitar magic strings
 * e facilitar refactor.
 */
export const TYPES = {
  Logger: Symbol.for('Logger'),
  Database: Symbol.for('Database'),
  Notifier: Symbol.for('Notifier'),
  AlertsRepository: Symbol.for('AlertsRepository'),
  JobRunsRepository: Symbol.for('JobRunsRepository'),
  JobOverridesRepository: Symbol.for('JobOverridesRepository'),
  JobLogsRepository: Symbol.for('JobLogsRepository'),
  HealthCheckRepository: Symbol.for('HealthCheckRepository'),
  PortfolioRepository: Symbol.for('PortfolioRepository'),
  JobEvents: Symbol.for('JobEvents'),
} as const;

export type DbName = 'desenrola' | 'workflow_processor' | 'monitors';
