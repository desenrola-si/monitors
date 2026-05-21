import { Container } from 'inversify';
import { Job } from '../lib/job.js';
import { HeartbeatJob } from './heartbeat.js';

/**
 * Registro central de jobs. Pra adicionar novo cron:
 *   1. criar `src/jobs/<nome>.ts` extendendo Job
 *   2. importar aqui e adicionar em JOB_CLASSES
 *
 * Sem auto-discovery — explicit é melhor que mágico.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const JOB_CLASSES: Array<new (...args: any[]) => Job> = [
  HeartbeatJob,
  // adicione novos jobs aqui
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
