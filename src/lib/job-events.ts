import { injectable } from 'inversify';
import { EventEmitter } from 'node:events';

export type JobStartedEvent = {
  type: 'job.started';
  name: string;
  startedAt: string;
  source: 'cron' | 'manual';
};

export type JobFinishedEvent = {
  type: 'job.finished';
  name: string;
  status: 'success' | 'failed';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  errorMessage: string | null;
};

export type JobScheduledEvent = {
  type: 'job.scheduled';
  name: string;
  schedule: string;
  scheduleDefault: string;
  isOverride: boolean;
};

export type JobEvent = JobStartedEvent | JobFinishedEvent | JobScheduledEvent;

/**
 * Event bus pra comunicar lifecycle dos jobs entre o daemon (que executa
 * runJob) e o HTTP server (que serve /api/jobs/stream via SSE). Cada cliente
 * SSE registra um listener; daemon emite 1x e todos clientes recebem.
 *
 * Em escala de 1-2 usuários (caso atual), in-memory EventEmitter é suficiente.
 * Se Railway escalar pra múltiplas réplicas, trocaria por Redis pubsub.
 */
@injectable()
export class JobEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // EventEmitter default warning é em 10 listeners. Permitimos mais
    // por causa de múltiplas abas/tabs de dashboard abertas.
    this.emitter.setMaxListeners(50);
  }

  emit(event: JobEvent): void {
    this.emitter.emit('event', event);
  }

  on(listener: (event: JobEvent) => void): void {
    this.emitter.on('event', listener);
  }

  off(listener: (event: JobEvent) => void): void {
    this.emitter.off('event', listener);
  }
}
