import cronstrue from 'cronstrue/i18n';
import { CronExpressionParser } from 'cron-parser';

/**
 * Converte expressão cron em texto natural pt-BR.
 * Ex: "*\/5 * * * *" → "A cada 5 minutos"
 *     "0 6 * * *"   → "Às 06:00"
 */
export function humanizeCron(expr: string): string {
  try {
    return cronstrue.toString(expr, {
      locale: 'pt_BR',
      verbose: false,
      use24HourTimeFormat: true,
    });
  } catch {
    return expr;
  }
}

/**
 * Calcula a próxima ocorrência do cron na timezone dada.
 * Retorna null se a expressão for inválida.
 */
export function nextRunAt(expr: string, timezone: string): Date | null {
  try {
    const interval = CronExpressionParser.parse(expr, { tz: timezone });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/**
 * Formato amigável: "em 3min", "em 2h 15m", "em 14h".
 * Pra distâncias pequenas (< 60s) retorna "agora".
 */
export function formatCountdown(target: Date, now: Date = new Date()): string {
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return 'agora';
  const totalSec = Math.floor(diffMs / 1000);
  if (totalSec < 60) return `em ${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `em ${min}min`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) {
    return remMin > 0 ? `em ${hr}h ${remMin}m` : `em ${hr}h`;
  }
  const days = Math.floor(hr / 24);
  return `em ${days}d`;
}

/**
 * Hora no formato HH:MM BRT.
 */
export function formatBrtTime(d: Date): string {
  // toLocaleTimeString com timezone forçada — funciona em browser moderno
  return d.toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  });
}
