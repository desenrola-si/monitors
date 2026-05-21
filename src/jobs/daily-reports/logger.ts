import { Logger as MonitorsLogger } from '../../lib/logger.js';

let _log: MonitorsLogger | null = null;

export function initLogger(l: MonitorsLogger): void {
  _log = l;
}

function ensure(): MonitorsLogger {
  if (!_log) {
    throw new Error('daily-reports logger não inicializado — chame initLogger() antes de usar');
  }
  return _log;
}

export const logger = {
  debug: (msg: string, meta?: unknown): void =>
    ensure().debug(toObj(meta), msg),
  info: (msg: string, meta?: unknown): void =>
    ensure().info(toObj(meta), msg),
  warn: (msg: string, meta?: unknown): void =>
    ensure().warn(toObj(meta), msg),
  error: (msg: string, meta?: unknown): void =>
    ensure().error(toObj(meta), msg),
};

function toObj(meta: unknown): object {
  if (meta == null) return {};
  if (typeof meta === 'object') return meta as object;
  return { meta };
}
