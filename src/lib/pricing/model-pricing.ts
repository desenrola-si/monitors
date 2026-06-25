export interface ModelPricing {
  inputCacheMiss: number;
  inputCacheHit: number;
  output: number;
}

export interface TokenUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

const PER_MILLION = 1_000_000;

const PRICING: Record<string, ModelPricing> = {
  'deepseek-v4-flash': { inputCacheMiss: 0.14, inputCacheHit: 0.0028, output: 0.28 },
  'deepseek-v4-pro': { inputCacheMiss: 0.435, inputCacheHit: 0.003625, output: 0.87 },
};

const ALIASES: Record<string, string> = {
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
};

export function findPricing(model: string | null | undefined): ModelPricing | null {
  if (!model) return null;
  const key = model.toLowerCase();
  return PRICING[key] ?? PRICING[ALIASES[key]] ?? null;
}

export function computeCostUsd(model: string | null | undefined, usage: TokenUsage): number | null {
  const pricing = findPricing(model);
  if (!pricing) return null;

  const freshInput = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (
    (freshInput * pricing.inputCacheMiss +
      usage.cachedTokens * pricing.inputCacheHit +
      usage.completionTokens * pricing.output) /
    PER_MILLION
  );
}

export function isModelPriced(model: string | null | undefined): boolean {
  return findPricing(model) !== null;
}
