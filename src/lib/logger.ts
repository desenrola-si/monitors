import { injectable } from 'inversify';
import pino, { Logger as PinoLogger } from 'pino';
import { JobEvents, JobLogLevel } from './job-events.js';

@injectable()
export class Logger {
  private base: PinoLogger;
  private boundJob?: string;
  private events?: JobEvents;

  constructor() {
    const usePretty =
      process.env.LOG_PRETTY === 'true' ||
      (process.env.LOG_PRETTY !== 'false' && process.env.NODE_ENV !== 'production');

    this.base = pino({
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: { err: pino.stdSerializers.err },
      ...(usePretty && {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname,job',
            singleLine: false,
            levelFirst: true,
            messageFormat: '{if job}[{job}] {end}{msg}',
          },
        },
      }),
    });
  }

  /**
   * Liga o emissor de eventos. Chamado pelo daemon no boot — todo log que
   * vier de um child logger com `job` bound vai gerar JobLogEvent em paralelo
   * ao stdout normal. Sem isso, Logger opera só com pino (default).
   */
  setJobEvents(events: JobEvents): void {
    this.events = events;
  }

  info(obj: object | string, msg?: string): void {
    typeof obj === 'string' ? this.base.info(obj) : this.base.info(obj, msg);
    this.emitJobLog('info', obj, msg);
  }
  warn(obj: object | string, msg?: string): void {
    typeof obj === 'string' ? this.base.warn(obj) : this.base.warn(obj, msg);
    this.emitJobLog('warn', obj, msg);
  }
  error(obj: object | string, msg?: string): void {
    typeof obj === 'string' ? this.base.error(obj) : this.base.error(obj, msg);
    this.emitJobLog('error', obj, msg);
  }
  debug(obj: object | string, msg?: string): void {
    typeof obj === 'string' ? this.base.debug(obj) : this.base.debug(obj, msg);
    this.emitJobLog('debug', obj, msg);
  }

  /**
   * Cria logger filho com bindings extras (ex: { job: 'heartbeat' }).
   * Jobs devem usar pra ter context automático em todos os logs.
   * O child herda o jobEvents do parent + lê `job` dos bindings pra usar
   * como boundJob (assim os logs do child viram JobLogEvents).
   */
  child(bindings: object): Logger {
    const child = Object.create(Logger.prototype) as Logger;
    child.base = this.base.child(bindings);
    child.events = this.events;
    const bindingsJob = (bindings as { job?: unknown }).job;
    child.boundJob =
      typeof bindingsJob === 'string' ? bindingsJob : this.boundJob;
    return child;
  }

  private emitJobLog(
    level: JobLogLevel,
    obj: object | string,
    msg?: string,
  ): void {
    if (!this.events || !this.boundJob) return;
    const message = typeof obj === 'string' ? obj : (msg ?? '');
    const data =
      typeof obj === 'object' && obj !== null ? sanitizeData(obj) : null;
    this.events.emit({
      type: 'job.log',
      name: this.boundJob,
      level,
      message,
      data,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Remove keys ruidosas (job, level interno do pino) e serializa errors
 * pra ficar legível no frontend.
 */
function sanitizeData(obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === 'job') continue;
    if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message, stack: v.stack };
    } else {
      out[k] = v;
    }
  }
  return out;
}
