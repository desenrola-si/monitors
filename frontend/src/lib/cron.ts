import cronstrue from 'cronstrue/i18n';

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
