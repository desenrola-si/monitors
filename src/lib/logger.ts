import { injectable } from 'inversify';
import pino, { Logger as PinoLogger } from 'pino';

@injectable()
export class Logger {
  private base: PinoLogger;

  constructor() {
    const isDev = process.env.NODE_ENV !== 'production';
    this.base = pino({
      level: process.env.LOG_LEVEL ?? 'info',
      ...(isDev && {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l' },
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
