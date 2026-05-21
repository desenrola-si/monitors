import { DateTime } from 'luxon';
import { PortfolioWindow } from './types.js';
import { WINDOW } from './config.js';

/**
 * Janela do snapshot: o "dia atual" é o dia ANTERIOR em BRT.
 *
 * Roda às 07:00 BRT, então o dia 22/05 às 07:00 BRT escreve report_date =
 * '2026-05-21' com janela [2026-05-21 00:00 BRT, 2026-05-22 00:00 BRT).
 *
 * Baseline = 7 dias anteriores ao current.
 */
export function buildYesterdayWindow(): PortfolioWindow {
  const nowBrt = DateTime.now().setZone('America/Sao_Paulo');
  const todayBrt = nowBrt.startOf('day');
  const yesterdayBrt = todayBrt.minus({ days: 1 });

  const currentStart = yesterdayBrt.toJSDate();
  const currentEnd = todayBrt.toJSDate();
  const baselineStart = yesterdayBrt
    .minus({ days: WINDOW.baselineDays })
    .toJSDate();
  const baselineEnd = currentStart;

  return {
    reportDate: yesterdayBrt.toFormat('yyyy-LL-dd'),
    currentStart,
    currentEnd,
    baselineStart,
    baselineEnd,
  };
}
