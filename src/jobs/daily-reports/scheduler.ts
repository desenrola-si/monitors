import { DateTime } from 'luxon';

const TZ = 'America/Sao_Paulo';

/**
 * Data de ontem em formato YYYY-MM-DD na timezone America/Sao_Paulo.
 * O agendamento (cron 0 6 * * * BRT) sempre dispara o relatório de ontem.
 */
export function yesterdayInSaoPaulo(now: Date = new Date()): string {
  return DateTime.fromJSDate(now)
    .setZone(TZ)
    .minus({ days: 1 })
    .toFormat('yyyy-LL-dd');
}
