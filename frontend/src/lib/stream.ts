export interface JobStartedEvent {
  type: 'job.started';
  name: string;
  startedAt: string;
  source: 'cron' | 'manual';
}

export interface JobFinishedEvent {
  type: 'job.finished';
  name: string;
  status: 'success' | 'failed';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  errorMessage: string | null;
}

export interface JobScheduledEvent {
  type: 'job.scheduled';
  name: string;
  schedule: string;
  scheduleDefault: string;
  isOverride: boolean;
}

export type JobLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface JobLogEvent {
  type: 'job.log';
  name: string;
  level: JobLogLevel;
  message: string;
  data: Record<string, unknown> | null;
  timestamp: string;
}

export type JobEvent =
  | JobStartedEvent
  | JobFinishedEvent
  | JobScheduledEvent
  | JobLogEvent;

interface Handlers {
  onJobStarted?: (e: JobStartedEvent) => void;
  onJobFinished?: (e: JobFinishedEvent) => void;
  onJobScheduled?: (e: JobScheduledEvent) => void;
  onJobLog?: (e: JobLogEvent) => void;
  onOpen?: () => void;
  onError?: () => void;
}

/**
 * Conecta no SSE de jobs e despacha eventos pros handlers. Browser reconecta
 * automaticamente em caso de queda (EventSource built-in). Retorna função de
 * cleanup pra chamar em onDestroy.
 */
export function connectJobsStream(handlers: Handlers): () => void {
  const es = new EventSource('/api/jobs/stream', { withCredentials: true });

  es.onopen = () => handlers.onOpen?.();
  es.onerror = () => handlers.onError?.();

  es.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as JobEvent;
      if (event.type === 'job.started') handlers.onJobStarted?.(event);
      else if (event.type === 'job.finished') handlers.onJobFinished?.(event);
      else if (event.type === 'job.scheduled') handlers.onJobScheduled?.(event);
      else if (event.type === 'job.log') handlers.onJobLog?.(event);
    } catch (err) {
      console.warn('SSE parse error', err, msg.data);
    }
  };

  return () => es.close();
}
