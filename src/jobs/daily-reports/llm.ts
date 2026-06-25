import OpenAI from 'openai';
import { config } from './config.js';
import { logger } from './logger.js';

const client = new OpenAI({
  apiKey: config.deepseek.apiKey,
  baseURL: config.deepseek.baseUrl,
  timeout: 180_000,
  maxRetries: 2,
});

export interface LlmResult {
  message: string;
  model: string;
  tokens: { input: number; output: number };
}

export async function chatJson<T>(args: {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
}): Promise<{ data: T; tokens: { input: number; output: number } }> {
  const model = args.model ?? config.deepseek.model;
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: args.systemPrompt },
      { role: 'user', content: args.userPrompt },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('chatJson: DeepSeek retornou conteúdo vazio');
  }

  return {
    data: JSON.parse(content) as T,
    tokens: {
      input: response.usage?.prompt_tokens ?? 0,
      output: response.usage?.completion_tokens ?? 0,
    },
  };
}

export async function generateReport(args: {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  temperature?: number;
}): Promise<LlmResult> {
  const model = args.model ?? config.deepseek.model;
  const t0 = Date.now();

  logger.debug('LLM request start', { model });
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: args.systemPrompt },
      { role: 'user', content: args.userPrompt },
    ],
    temperature: args.temperature ?? 0.4,
  });

  const choice = response.choices[0];
  const content = choice?.message?.content?.trim();
  if (!content) {
    throw new Error(
      `DeepSeek retornou conteúdo vazio (finish_reason=${
        choice?.finish_reason ?? 'unknown'
      })`,
    );
  }

  logger.debug('LLM request done', {
    model: response.model,
    ms: Date.now() - t0,
    tokens: response.usage,
  });

  return {
    message: content,
    model: response.model,
    tokens: {
      input: response.usage?.prompt_tokens ?? 0,
      output: response.usage?.completion_tokens ?? 0,
    },
  };
}
