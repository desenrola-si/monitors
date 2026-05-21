/**
 * Conversões entre presets humanos e expressões cron 5-field.
 * Tenta sempre manter a UI longe de cron — usuário pensa em "a cada N min"
 * ou "todo dia às HH:MM", a lib converte.
 */

export type ScheduleMode = 'frequency' | 'time-of-day' | 'advanced';

export type FrequencyUnit = 'minutes' | 'hours' | 'days';

export interface FrequencyPreset {
  mode: 'frequency';
  every: number;
  unit: FrequencyUnit;
}

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=domingo

export interface TimeOfDayPreset {
  mode: 'time-of-day';
  hour: number;
  minute: number;
  /** Dias da semana selecionados. Vazio ou completo = todos os dias. */
  weekdays: Weekday[];
}

export interface AdvancedPreset {
  mode: 'advanced';
  cron: string;
}

export type SchedulePreset = FrequencyPreset | TimeOfDayPreset | AdvancedPreset;

// ────────────────────────────────────────────────────────────────────────
// Preset → Cron
// ────────────────────────────────────────────────────────────────────────

export function presetToCron(p: SchedulePreset): string {
  if (p.mode === 'advanced') return p.cron.trim();

  if (p.mode === 'frequency') {
    const n = Math.max(1, Math.floor(p.every));
    if (p.unit === 'minutes') {
      if (n === 1) return '* * * * *';
      if (n >= 60) return `0 */${Math.floor(n / 60)} * * *`;
      return `*/${n} * * * *`;
    }
    if (p.unit === 'hours') {
      if (n === 1) return '0 * * * *';
      return `0 */${n} * * *`;
    }
    // days
    if (n === 1) return '0 0 * * *';
    return `0 0 */${n} * *`;
  }

  // time-of-day
  const mm = p.minute;
  const hh = p.hour;
  const weekdays = normalizeWeekdays(p.weekdays);
  const dow = weekdays.length === 0 || weekdays.length === 7 ? '*' : weekdays.join(',');
  return `${mm} ${hh} * * ${dow}`;
}

function normalizeWeekdays(wds: Weekday[]): Weekday[] {
  const unique = Array.from(new Set(wds)).sort((a, b) => a - b);
  return unique as Weekday[];
}

// ────────────────────────────────────────────────────────────────────────
// Cron → Preset (best-effort)
// ────────────────────────────────────────────────────────────────────────

/**
 * Tenta detectar qual preset bate exato com o cron. Se nenhum bate, retorna
 * advanced. Útil pra abrir o editor já no modo correto quando o usuário
 * clica em "Editar".
 */
export function detectPreset(cron: string): SchedulePreset {
  const trimmed = cron.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return { mode: 'advanced', cron: trimmed };

  const [m, h, dom, mon, dow] = parts;

  // ── Frequency mode ──
  if (dom === '*' && mon === '*' && dow === '*') {
    // "* * * * *" = a cada minuto
    if (m === '*' && h === '*') {
      return { mode: 'frequency', every: 1, unit: 'minutes' };
    }
    // "*/N * * * *" = a cada N minutos
    const everyMinMatch = m?.match(/^\*\/(\d+)$/);
    if (everyMinMatch && h === '*') {
      return { mode: 'frequency', every: parseInt(everyMinMatch[1]!, 10), unit: 'minutes' };
    }
    // "0 * * * *" = a cada hora
    if (m === '0' && h === '*') {
      return { mode: 'frequency', every: 1, unit: 'hours' };
    }
    // "0 */N * * *" = a cada N horas
    const everyHourMatch = h?.match(/^\*\/(\d+)$/);
    if (m === '0' && everyHourMatch) {
      return { mode: 'frequency', every: parseInt(everyHourMatch[1]!, 10), unit: 'hours' };
    }
  }

  // "0 0 * * *" = todo dia à meia-noite (vira time-of-day às 00:00)
  // "0 0 */N * *" = a cada N dias
  if (m === '0' && h === '0' && mon === '*' && dow === '*') {
    const everyDayMatch = dom?.match(/^\*\/(\d+)$/);
    if (everyDayMatch) {
      return { mode: 'frequency', every: parseInt(everyDayMatch[1]!, 10), unit: 'days' };
    }
  }

  // ── Time of day mode ──
  // "MM HH * * DOW" — minute e hour numéricos, dom e mon *
  const mNum = parseIntStrict(m);
  const hNum = parseIntStrict(h);
  if (mNum !== null && hNum !== null && dom === '*' && mon === '*') {
    const weekdays = parseWeekdays(dow ?? '*');
    if (weekdays !== null) {
      return {
        mode: 'time-of-day',
        hour: hNum,
        minute: mNum,
        weekdays,
      };
    }
  }

  return { mode: 'advanced', cron: trimmed };
}

function parseIntStrict(s: string | undefined): number | null {
  if (!s || !/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parseWeekdays(s: string): Weekday[] | null {
  if (s === '*') return [];
  // "1-5" → [1,2,3,4,5]
  const rangeMatch = s.match(/^(\d)-(\d)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1]!, 10);
    const end = parseInt(rangeMatch[2]!, 10);
    if (start <= end && start >= 0 && end <= 6) {
      const out: Weekday[] = [];
      for (let i = start; i <= end; i++) out.push(i as Weekday);
      return out;
    }
  }
  // "1,3,5" → [1,3,5]
  if (/^\d(,\d)*$/.test(s)) {
    return s.split(',').map((d) => parseInt(d, 10) as Weekday);
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Labels pt-BR
// ────────────────────────────────────────────────────────────────────────

export const UNIT_LABELS_PT: Record<FrequencyUnit, { singular: string; plural: string }> = {
  minutes: { singular: 'minuto', plural: 'minutos' },
  hours: { singular: 'hora', plural: 'horas' },
  days: { singular: 'dia', plural: 'dias' },
};

export const WEEKDAY_LABELS_PT: Record<Weekday, { short: string; long: string }> = {
  0: { short: 'Dom', long: 'Domingo' },
  1: { short: 'Seg', long: 'Segunda' },
  2: { short: 'Ter', long: 'Terça' },
  3: { short: 'Qua', long: 'Quarta' },
  4: { short: 'Qui', long: 'Quinta' },
  5: { short: 'Sex', long: 'Sexta' },
  6: { short: 'Sáb', long: 'Sábado' },
};
