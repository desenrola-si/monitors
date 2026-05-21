function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  deepseek: {
    apiKey: required('DEEPSEEK_API_KEY'),
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    // v4-flash tem janela de 1M tokens, necessária pra Fase D (até N=100
    // amostras de conversas reais ⇒ ~900k tokens de input).
    model: process.env.DAILY_REPORTS_DEEPSEEK_MODEL || 'deepseek-v4-flash',
  },

  conversationSamples: {
    n: Number(process.env.DAILY_REPORTS_CONVERSATION_SAMPLES_N || 100),
  },
};
