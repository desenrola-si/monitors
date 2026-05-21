import OpenAI from 'openai';
import { Logger } from '../../lib/logger.js';
import {
  DimensionResult,
  OverallStatus,
  PortfolioTenant,
} from './types.js';
import { LLM } from './config.js';

/**
 * Gera 1-2 frases executivas pro card do tenant. Tom de dono falando do
 * portfólio — não operacional, não técnico. Foco em "o que olhar amanhã".
 *
 * Reusa o mesmo provider DeepSeek dos daily-reports (OpenAI SDK + baseURL
 * custom). Wrapper local por enquanto — refactor futuro pra reusar o
 * AiProviderRegistry do backend NestJS.
 */

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  timeout: 60_000,
  maxRetries: 1,
});

const SYSTEM_PROMPT = `Você é um analista de portfolio falando com o dono da Desenrola \
(empresa que opera atendimentos com IA pra restaurantes e outras marcas). \
Sua função: olhar os sinais diários de cada cliente e escrever 1-2 frases \
EXECUTIVAS sobre o que o dono deveria olhar — atenção, oportunidade, ou \
status estável.

Regras estritas:
- Português brasileiro, tom direto e enxuto.
- NUNCA mencione números brutos repetidos (eles já estão nos cards). \
Use só se forem essenciais pra dar peso.
- Se status = 'risk', começe com "Atenção:" ou "Risco:" e indique a ação.
- Se status = 'attention', sugira o que investigar.
- Se status = 'excellent' ou 'healthy', se houver oportunidade (volume \
crescendo, conversão subindo) destaque como ação positiva. Senão, frase \
curta confirmando estabilidade — VARIE a forma, nunca template fixo.
- Não use jargão técnico (não fale em "endpoint", "API", "queue").
- Não invente fatos que não estão nos sinais.
- NUNCA ultrapasse 2 frases. Idealmente 1.`;

export interface NarratorInput {
  tenant: PortfolioTenant;
  overallStatus: OverallStatus;
  signals: DimensionResult[];
}

export interface NarratorOutput {
  narrative: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
}

export async function narrateOverall(
  input: NarratorInput,
  log: Logger,
): Promise<NarratorOutput | null> {
  if (input.tenant.isPlaceholder) {
    // Tenants sem prompt configurado têm narrativa determinística — não
    // gastamos LLM com eles
    return {
      narrative:
        'Cliente ativo, sem prompt da IA configurado — oportunidade de ativação.',
      model: 'deterministic',
      tokensInput: 0,
      tokensOutput: 0,
    };
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    log.warn('DEEPSEEK_API_KEY ausente — narrativa fallback determinística');
    return {
      narrative: fallbackNarrative(input),
      model: 'deterministic-fallback',
      tokensInput: 0,
      tokensOutput: 0,
    };
  }

  const userPrompt = buildUserPrompt(input);
  const t0 = Date.now();

  try {
    const response = await client.chat.completions.create({
      model: LLM.defaultModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: LLM.temperature,
      max_tokens: LLM.maxOutputTokens,
    });

    const choice = response.choices[0];
    const content = choice?.message?.content?.trim();
    if (!content) {
      log.warn(
        { tenant: input.tenant.id, finish: choice?.finish_reason },
        'LLM retornou conteúdo vazio — usando fallback',
      );
      return {
        narrative: fallbackNarrative(input),
        model: 'deterministic-fallback',
        tokensInput: response.usage?.prompt_tokens ?? 0,
        tokensOutput: response.usage?.completion_tokens ?? 0,
      };
    }

    log.debug(
      {
        tenant: input.tenant.id,
        ms: Date.now() - t0,
        tokens: response.usage,
      },
      'Narrativa gerada',
    );

    return {
      narrative: content,
      model: response.model,
      tokensInput: response.usage?.prompt_tokens ?? 0,
      tokensOutput: response.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    log.warn(
      { tenant: input.tenant.id, err: (err as Error).message },
      'LLM falhou — usando narrativa fallback',
    );
    return {
      narrative: fallbackNarrative(input),
      model: 'deterministic-fallback',
      tokensInput: 0,
      tokensOutput: 0,
    };
  }
}

function buildUserPrompt(input: NarratorInput): string {
  const tenantName = input.tenant.name ?? 'Cliente sem nome';
  const lines: string[] = [
    `Cliente: ${tenantName}`,
    `Status geral: ${input.overallStatus}`,
    '',
    'Sinais (1 por dimensão):',
  ];
  for (const s of input.signals) {
    lines.push(
      `- ${s.dimension} [${s.status}]: ${s.narrative}`,
    );
  }
  lines.push(
    '',
    'Escreva 1-2 frases pro card desse cliente, seguindo as regras do system.',
  );
  return lines.join('\n');
}

function fallbackNarrative(input: NarratorInput): string {
  const tenantName = input.tenant.name ?? 'Cliente';
  const summary = input.signals
    .filter((s) => s.status === 'critical' || s.status === 'attention')
    .map((s) => s.dimension)
    .join(', ');

  switch (input.overallStatus) {
    case 'risk':
      return summary
        ? `Atenção: ${tenantName} com problema em ${summary}.`
        : `Atenção: ${tenantName} precisa de revisão hoje.`;
    case 'attention':
      return summary
        ? `${tenantName}: vale olhar ${summary}.`
        : `${tenantName} merece um olhar.`;
    case 'excellent':
      return `${tenantName} indo bem em todas as frentes hoje.`;
    case 'healthy':
    default:
      return `${tenantName} estável hoje.`;
  }
}
