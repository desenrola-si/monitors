import { OverallStatus } from './types.js';
import { DimensionResult } from './types.js';

/**
 * Decide o status overall do tenant a partir dos 4 signals.
 *
 * Regra:
 *   - 1+ critical          → risk
 *   - 2+ attention         → attention
 *   - 1 attention isolado  → attention (rebaixado se 3+ positives compensam? não — atenção é atenção)
 *   - todas positive       → excellent
 *   - resto                → healthy
 *
 * `unknown` (sem dados) NÃO escala — só conta na contagem se >=3 unknowns =
 * "silencioso" (que vira healthy mesmo, deixando narrativa esclarecer).
 */
export function computeOverallStatus(
  signals: DimensionResult[],
): OverallStatus {
  let criticals = 0;
  let attentions = 0;
  let positives = 0;
  let neutrals = 0;
  for (const s of signals) {
    if (s.status === 'critical') criticals++;
    else if (s.status === 'attention') attentions++;
    else if (s.status === 'positive') positives++;
    else if (s.status === 'neutral') neutrals++;
  }

  if (criticals >= 1) return 'risk';
  if (attentions >= 2) return 'attention';
  if (attentions === 1) return 'attention';
  if (positives >= 2 && neutrals + positives === signals.length) return 'excellent';
  return 'healthy';
}
