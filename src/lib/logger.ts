import { injectable } from 'inversify';
import pino, { Logger as PinoLogger } from 'pino';

@injectable()
export class Logger {
  private base: PinoLogger;

  constructor() {
    // Pretty quando dev OU quando LOG_PRETTY=true (útil pra ver bonito no
    // dashboard Railway que renderiza ANSI colors). JSON puro só quando
    // LOG_PRETTY=false explícito (pra log drains que parseiam JSON).
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
            // {if job}…{end} blocos são suporte pino-pretty 11+: renderiza
            // só quando o campo está presente nos bindings/log
            messageFormat: '{if job}[{job}] {end}{msg}',
          },
        },
      }),
    });
  }

  info(obj: object | string, msg?: string): void {
    typeof obj === 'string' ? this.base.info(obj) : this.base.info(obj, msg);
  }
  warn(obj: object | string, msg?: string): void {
    typeof obj === 'string' ? this.base.warn(obj) : this.base.warn(obj, msg);
  }
  error(obj: object | string, msg?: string): void {
    typeof obj === 'string' ? this.base.error(obj) : this.base.error(obj, msg);
  }
  debug(obj: object | string, msg?: string): void {
    typeof obj === 'string' ? this.base.debug(obj) : this.base.debug(obj, msg);
  }

  /**
   * Cria logger filho com bindings extras (ex: { job: 'heartbeat' }).
   * Jobs devem usar pra ter context automático em todos os logs.
   */
  child(bindings: object): Logger {
    const child = Object.create(Logger.prototype) as Logger;
    child.base = this.base.child(bindings);
    return child;
  }
}
