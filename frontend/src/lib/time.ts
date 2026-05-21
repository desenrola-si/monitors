/**
 * Helpers de formatação BRT pra timestamps vindos da API (ISO 8601 UTC).
 */

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

export function toBrtDate(isoUtc: string): Date {
  const d = new Date(isoUtc);
  return new Date(d.getTime() - BRT_OFFSET_MS);
}

export function formatTime(isoUtc: string): string {
  const d = toBrtDate(isoUtc);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function formatDateTime(isoUtc: string): string {
  const d = toBrtDate(isoUtc);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Tempo decorrido em formato amigável com segundos visíveis pra suportar
 * countdown ao vivo (quando o caller passa `now` reativo):
 *   < 1s    → "agora"
 *   < 60s   → "Xs atrás"
 *   < 60min → "Xmin Ys atrás"
 *   < 24h   → "Xh Ymin atrás"
 *   >= 24h  → "Xd Yh atrás"
 */
export function formatRelative(isoUtc: string, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(isoUtc).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 1) return 'agora';
  if (sec < 60) return `${sec}s atrás`;
  const totalMin = Math.floor(sec / 60);
  const s = sec % 60;
  const m = totalMin % 60;
  const totalHr = Math.floor(totalMin / 60);
  const h = totalHr % 24;
  if (totalMin < 60) return `${m}min ${s}s atrás`;
  if (totalHr < 24) return `${h}h ${m}min atrás`;
  const d = Math.floor(totalHr / 24);
  return `${d}d ${h}h atrás`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}m ${pad(sec)}s`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
