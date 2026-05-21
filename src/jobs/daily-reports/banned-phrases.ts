import { desenrolaPool } from './db.js';
import { logger } from './logger.js';

export interface BannedPhrase {
  id: number;
  tenantId: string | null;
  phrase: string;
  regex: string;
  reason: string | null;
  onMatchAction: 'block' | 'fail';
}

/**
 * Carrega banned phrases aplicáveis ao tenant: globais (tenant_id NULL)
 * somadas com as específicas. Retorna array vazio se a tabela ainda não
 * existe (migration não aplicada) — degradação graciosa.
 */
export async function loadBannedPhrases(
  tenantId: string,
): Promise<BannedPhrase[]> {
  try {
    const { rows } = await desenrolaPool.query<{
      id: string;
      tenant_id: string | null;
      phrase: string;
      regex: string;
      reason: string | null;
      on_match_action: 'block' | 'fail';
    }>(
      `
        SELECT id, tenant_id, phrase, regex, reason, on_match_action
        FROM daily_report_banned_phrases
        WHERE tenant_id IS NULL OR tenant_id = $1
        ORDER BY id
      `,
      [tenantId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      tenantId: r.tenant_id,
      phrase: r.phrase,
      regex: r.regex,
      reason: r.reason,
      onMatchAction: r.on_match_action,
    }));
  } catch (err) {
    if (
      err instanceof Error &&
      /relation .* does not exist/i.test(err.message)
    ) {
      logger.warn(
        'Tabela daily_report_banned_phrases ainda não existe; rodando sem banned phrases.',
      );
      return [];
    }
    throw err;
  }
}

/**
 * Retorna o subset de banned phrases cuja regex dá match na mensagem.
 * Match é sempre case-insensitive (flag /i aplicada no compilador).
 * Regex inválida é logada e ignorada (não trava o pipeline).
 */
export function findMatches(
  message: string,
  phrases: BannedPhrase[],
): BannedPhrase[] {
  return phrases.filter((p) => matchesPhrase(message, p));
}

function matchesPhrase(message: string, phrase: BannedPhrase): boolean {
  try {
    return new RegExp(phrase.regex, 'i').test(message);
  } catch {
    logger.warn(
      `Banned phrase ${phrase.id} ("${phrase.phrase}") tem regex inválida em runtime: ${phrase.regex}. Ignorando.`,
    );
    return false;
  }
}

/**
 * Decide a ação final quando o output persiste com banned phrases após retry:
 * se QUALQUER match tem onMatchAction='fail', o relatório vai pra 'failed';
 * caso contrário, vai pra 'blocked' (preserva a mensagem pra revisão manual).
 */
export function decideFinalAction(matches: BannedPhrase[]): 'block' | 'fail' {
  return matches.some((m) => m.onMatchAction === 'fail') ? 'fail' : 'block';
}

export function buildBannedPhrasesPromptSection(
  phrases: BannedPhrase[],
): string {
  if (phrases.length === 0) return '';
  const lines = phrases.map((p) => {
    const reason = p.reason ? ` (motivo: ${p.reason})` : '';
    return `- "${p.phrase}"${reason}`;
  });
  return `\n\n### EXPRESSÕES PROIBIDAS\n\nVocê NÃO PODE usar nenhuma das seguintes expressões (nem variações próximas) no relatório:\n\n${lines.join('\n')}\n\nReescreva qualquer ideia evitando essas expressões.`;
}

export function buildRetryWarning(matches: BannedPhrase[]): string {
  const list = matches.map((m) => `- "${m.phrase}"`).join('\n');
  return `\n\nATENÇÃO: o seu output anterior continha as seguintes expressões PROIBIDAS (ou variações próximas delas):\n\n${list}\n\nReescreva o relatório INTEIRO removendo essas expressões. Não use sinônimos próximos. Não as parafraseie.`;
}
