/**
 * Thresholds determinísticos por dimensão. Mantemos em arquivo único pra
 * facilitar tuning sem ter que caçar números espalhados pelos checks.
 *
 * Todas as porcentagens são "current vs baseline 7d (média diária)".
 */
export const VOLUME = {
  // Queda acentuada do volume diário
  attentionDropPct: 30,
  criticalDropPct: 60,
  // Crescimento que merece destaque positivo
  positiveGrowthPct: 30,
  // Volume mínimo absoluto pra dimensão ser informativa.
  // Tenants com <3 sessões/dia em média entram como `unknown`.
  minBaselineToScore: 3,
} as const;

export const FRUSTRATION = {
  // Quantas escalações pra humano no dia ainda é "normal"
  toleratedDailyEscalations: 1,
  // Crescimento da taxa (escalações/sessões) vs baseline
  attentionGrowthPct: 50,
  criticalGrowthPct: 100,
} as const;

export const CONVERSION = {
  // Conversão (reservas confirmadas / sessões iniciadas)
  attentionDropPct: 20,
  criticalDropPct: 40,
  positiveGrowthPct: 25,
  // Mínimo de sessões pra calcular taxa de forma significativa
  minSessionsToScore: 5,
} as const;

export const OPERATIONS = {
  // Findings do health-check técnico associados ao tenant no dia
  neutralMax: 0,    // <= 0 → positive
  attentionMax: 2,  // 1-2 → neutral (ruído operacional pequeno)
  // 3-5 → attention
  // 6+ → critical
  criticalMin: 6,
} as const;

export const LLM = {
  // Mesmo modelo dos daily-reports — pt-BR fluente, custo baixo
  defaultModel: process.env.PORTFOLIO_DEEPSEEK_MODEL || 'deepseek-v4-flash',
  temperature: 0.45,
  // DeepSeek conta reasoning_tokens + completion no mesmo budget. Em tenants
  // com muitos sinais o reasoning estourava 200 e zerava a narrativa
  // (finish_reason=length). 1500 dá folga confortável; custo desprezível.
  maxOutputTokens: 1500,
} as const;

export const WINDOW = {
  baselineDays: 7,
} as const;
