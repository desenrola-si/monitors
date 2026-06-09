import { Check, CheckContext, CheckResult } from '../check.js';

const WINDOW_HOURS = 24;
const MIN_OCCURRENCES = 1;
const ADJACENCY_CHARS = 20; // distância máx entre o dia-da-semana e a data

// Normalizado (sem acento, sem "-feira", minúsculo) -> getUTCDay (0=Dom..6=Sáb)
const WEEKDAY_TO_DOW: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

const WD = '(?:domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado)(?:[-\\s]?feira)?';
const WEEKDAY_RE = new RegExp(`(${WD})`, 'gi');
const DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
// Intervalo/lista: "segunda a sexta", "segunda à sexta", "segunda e quarta".
// Dias-da-semana dentro de um intervalo NÃO afirmam a data próxima.
const RANGE_RE = new RegExp(`${WD}\\s*(?:a|à|até|e|,)\\s*${WD}`, 'gi');

interface Mismatch {
  said: string; // dia-da-semana citado
  date: string; // DD/MM[/YYYY] citado
  actual: string; // dia-da-semana real da data
}

interface DateMatch {
  index: number;
  dd: number;
  mm: number;
  yyyy?: string;
  raw: string;
}

interface Row {
  tenant_id: string;
  tenant_name: string | null;
  request_id: string;
  message: string;
  at_brt: string;
}

/**
 * Detecta mensagens da operação (IA/atendente/template) que citam um
 * dia-da-semana que NÃO corresponde à data informada na mesma frase —
 * ex.: "sexta-feira, 06/06" quando 06/06 é sábado.
 *
 * É o sinal observável e auto-contido do bug de geração de data
 * (a percepção de "data agendada ≠ combinada" do cliente). Não depende
 * de fonte externa nem de comparar duas datas armazenadas.
 *
 * Janela de 24h: o alerta persiste enquanto houver mensagem ruim recente
 * e auto-resolve quando ela envelhece.
 */
export class AnthrotechDateWeekdayMismatchCheck implements Check {
  readonly code = 'anthrotech_date_weekday_mismatch';
  readonly alertTypeCode = 'anthrotech_date_weekday_mismatch' as const;
  readonly description =
    'Mensagem cita dia-da-semana que não corresponde à data informada';

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const rows = await ctx.db.query<Row>(
      `
      SELECT
        ml.tenant_id,
        t.name AS tenant_name,
        ml.request_id,
        ml.message,
        TO_CHAR((ml.receivad_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS at_brt
      FROM message_logs ml
      LEFT JOIN tenants t ON t.id::text = ml.tenant_id
      WHERE ml.origin IN ('agent', 'tenant', 'template')
        AND ml.receivad_at >= NOW() - INTERVAL '${WINDOW_HOURS} hours'
        AND ml.message ~* '(domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado)'
        AND ml.message ~ '[0-9]{1,2}/[0-9]{1,2}'
      `,
      [],
      'desenrola',
    );

    const perTenant = new Map<
      string,
      {
        tenantName: string | null;
        count: number;
        sample: Mismatch | null;
        oldest: string;
      }
    >();

    for (const row of rows) {
      const mismatches = this.findMismatches(row.message);
      if (mismatches.length === 0) continue;

      const entry = perTenant.get(row.tenant_id) ?? {
        tenantName: row.tenant_name,
        count: 0,
        sample: null as Mismatch | null,
        oldest: row.at_brt,
      };
      entry.count += 1;
      if (!entry.sample) entry.sample = mismatches[0];
      perTenant.set(row.tenant_id, entry);
    }

    const results: CheckResult[] = [];
    for (const [tenantId, e] of perTenant) {
      const severity = e.count >= 3 ? 'critical' : 'warning';
      const label = e.tenantName ?? tenantId;
      const s = e.sample;
      const example = s
        ? ` (ex.: "${s.said}, ${s.date}" — ${s.date} é ${s.actual})`
        : '';
      results.push({
        tenantId,
        tenantName: e.tenantName,
        severity,
        metricValue: e.count,
        payload: {
          mismatch_count: e.count,
          window_hours: WINDOW_HOURS,
          sample: s,
        },
        notificationText:
          `${severity === 'critical' ? '🔴' : '🟡'} *${label}* — ` +
          `${e.count} mensagem(ns) com dia-da-semana que não bate com a data${example}. ` +
          `Cliente pode se programar pro dia errado — checar geração de data nos templates/IA.`,
      });
    }

    return results.filter((r) => (r.metricValue ?? 0) >= MIN_OCCURRENCES);
  }

  /**
   * Acha pares dia-da-semana + data adjacentes onde o dia-da-semana diverge.
   *
   * Pareia cada DIA-DA-SEMANA com a DATA MAIS PRÓXIMA (não cada data com o
   * weekday mais próximo). Em listas de opções tipo "amanhã 09/06, quarta
   * 10/06, quinta 11/06", o "quarta" precisa colar no 10/06 (que ele rotula),
   * não no 09/06 anterior — senão gera falso positivo. Cada weekday rotula a
   * data que está logo ao lado dele.
   */
  private findMismatches(message: string): Mismatch[] {
    const weekdays = this.collectWeekdays(message);
    if (weekdays.length === 0) return [];

    const dates = this.collectDates(message);
    if (dates.length === 0) return [];

    const out: Mismatch[] = [];
    for (const w of weekdays) {
      const wEnd = w.index + w.label.length;
      let best: { date: DateMatch; gap: number; comma: boolean } | null = null;

      for (const d of dates) {
        const dEnd = d.index + d.raw.length;
        // Gap (em chars) entre os dois tokens; sobreposição conta como 0.
        const gap =
          d.index >= wEnd
            ? d.index - wEnd
            : w.index >= dEnd
              ? w.index - dEnd
              : 0;
        if (gap > ADJACENCY_CHARS) continue;

        // Vírgula entre eles sinaliza separador de lista — desempata a favor
        // do lado sem vírgula ("09/06, quarta 10/06" → quarta cola no 10/06).
        const between =
          d.index >= wEnd
            ? message.slice(wEnd, d.index)
            : message.slice(dEnd, w.index);
        const comma = between.includes(',');

        if (
          best === null ||
          gap < best.gap ||
          (gap === best.gap && !comma && best.comma)
        ) {
          best = { date: d, gap, comma };
        }
      }

      if (!best) continue;

      const { dd, mm, yyyy, raw } = best.date;
      const year = this.resolveYear(dd, mm, yyyy);
      const actualDow = new Date(Date.UTC(year, mm - 1, dd)).getUTCDay();
      if (Number.isNaN(actualDow)) continue;

      if (actualDow !== w.dow) {
        out.push({ said: w.label, date: raw, actual: dowLabel(actualDow) });
      }
    }
    return out;
  }

  private collectDates(message: string): DateMatch[] {
    const dates: DateMatch[] = [];
    DATE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DATE_RE.exec(message)) !== null) {
      const dd = Number(m[1]);
      const mm = Number(m[2]);
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31) continue;
      dates.push({ index: m.index, dd, mm, yyyy: m[3], raw: m[0] });
    }
    return dates;
  }

  private collectWeekdays(
    message: string,
  ): { index: number; dow: number; label: string }[] {
    const rangeSpans = this.collectRangeSpans(message);
    const found: { index: number; dow: number; label: string }[] = [];
    WEEKDAY_RE.lastIndex = 0;
    let w: RegExpExecArray | null;
    while ((w = WEEKDAY_RE.exec(message)) !== null) {
      const start = w.index;
      const end = start + w[0].length;
      const inRange = rangeSpans.some((s) => start < s.end && end > s.start);
      if (inRange) continue;
      const norm = stripAccents(w[1].split(/[-\s]/)[0].toLowerCase());
      const dow = WEEKDAY_TO_DOW[norm];
      if (dow !== undefined) {
        found.push({ index: start, dow, label: w[0] });
      }
    }
    return found;
  }

  private collectRangeSpans(
    message: string,
  ): { start: number; end: number }[] {
    const spans: { start: number; end: number }[] = [];
    RANGE_RE.lastIndex = 0;
    let r: RegExpExecArray | null;
    while ((r = RANGE_RE.exec(message)) !== null) {
      spans.push({ start: r.index, end: r.index + r[0].length });
    }
    return spans;
  }

  /**
   * Ano sem ano explícito: escolhe entre [atual-1, atual, atual+1] o que
   * deixa a data mais próxima de hoje (agendamentos são near-future, então
   * o ano mais próximo é quase sempre o correto). Com ano de 2 dígitos: 20YY.
   */
  private resolveYear(dd: number, mm: number, yyyy?: string): number {
    if (yyyy) {
      const n = Number(yyyy);
      return yyyy.length === 2 ? 2000 + n : n;
    }
    const now = new Date();
    const base = now.getUTCFullYear();
    let best = base;
    let bestDiff = Infinity;
    for (const y of [base - 1, base, base + 1]) {
      const diff = Math.abs(Date.UTC(y, mm - 1, dd) - now.getTime());
      if (diff < bestDiff) {
        bestDiff = diff;
        best = y;
      }
    }
    return best;
  }
}

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function dowLabel(dow: number): string {
  return [
    'domingo',
    'segunda-feira',
    'terça-feira',
    'quarta-feira',
    'quinta-feira',
    'sexta-feira',
    'sábado',
  ][dow];
}
