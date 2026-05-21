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
 * Formato amigável com segundos visíveis pra criar sensação de tempo real:
 *   < 60s     → "em Xs"
 *   < 60min   → "em Xmin Ys"
 *   < 24h     → "em Xh Ymin Zs"
 *   >= 24h    → "em Xd Yh"
 *
 * Atualizado a cada 1s pelo componente que chama → countdown ao vivo.
 */
export function formatCountdown(target: Date, now: Date = new Date()): string {
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return 'agora';
  const totalSec = Math.floor(diffMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const totalHr = Math.floor(totalMin / 60);
  const h = totalHr % 24;
  const d = Math.floor(totalHr / 24);

  if (d > 0) return `em ${d}d ${h}h`;
  if (totalHr > 0) return `em ${h}h ${m}min ${s}s`;
  if (totalMin > 0) return `em ${m}min ${s}s`;
  return `em ${s}s`;
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
