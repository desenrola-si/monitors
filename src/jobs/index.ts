import { Container } from 'inversify';
import { Job } from '../lib/job.js';
import { FrustrationMonitorJob } from './frustration-monitor.js';
import { DailyReportsJob } from './daily-reports/job.js';
import { HealthCheckJob } from './health-check/job.js';
import { PortfolioReportJob } from './portfolio-report/job.js';
import { AnthrotechAvailabilityBypassJob } from './anthrotech-availability-bypass-monitor.js';
import { AnthrotechDateBruteforceJob } from './anthrotech-date-bruteforce-monitor.js';
import { CustomerDuplicateWaIdDriftJob } from './customer-duplicate-wa-id-drift-monitor.js';
import { CustomerMultiAccountComplianceJob } from './customer-multi-account-compliance-monitor.js';
import { AiRagQualityMonitorJob } from './ai-rag-quality-monitor.js';
import { DuplicateSendMonitorJob } from './duplicate-send-monitor.js';
import { FornalleVerboseRepliesMonitorJob } from './fornalle-verbose-replies-monitor.js';

/**
 * Registro central de jobs. Pra adicionar novo cron:
 *   1. criar `src/jobs/<nome>.ts` extendendo Job
 *   2. importar aqui e adicionar em JOB_CLASSES
 *
 * Sem auto-discovery — explicit é melhor que mágico.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const JOB_CLASSES: Array<new (...args: any[]) => Job> = [
  FrustrationMonitorJob,
  DailyReportsJob,
  HealthCheckJob,
  PortfolioReportJob,
  AnthrotechAvailabilityBypassJob,
  AnthrotechDateBruteforceJob,
  CustomerDuplicateWaIdDriftJob,
  CustomerMultiAccountComplianceJob,
  AiRagQualityMonitorJob,
  DuplicateSendMonitorJob,
  FornalleVerboseRepliesMonitorJob,
];

export function registerJobs(container: Container): void {
  for (const Klass of JOB_CLASSES) {
    container.bind(Klass).toSelf().inSingletonScope();
  }
}

export function getAllJobs(container: Container): Job[] {
  return JOB_CLASSES.map((Klass) => container.get(Klass));
}

export function getJobByName(container: Container, name: string): Job | undefined {
  return getAllJobs(container).find((j) => j.name === name);
}
