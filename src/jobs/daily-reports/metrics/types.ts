import type { SampledConversations } from './conversations.js';

export interface DesenrolaMetrics {
  messages: {
    total: number;
    byOrigin: {
      user: number;
      agent: number;
      tenant: number;
      template: number;
    };
    uniqueCustomers: number;
    uniqueSessions: number;
    firstActivityBrt: string | null;
    lastActivityBrt: string | null;
    peakHour: { hourBrt: number; count: number } | null;
  };
  sessions: {
    started: number;
  };
  humanHandoff: {
    customersHandedOff: number;
  };
}

export interface WorkflowMetrics {
  executions: {
    total: number;
    completed: number;
    failed: number;
    timeout: number;
    other: number;
  };
  latencyMs: {
    avg: number | null;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
  toolUsage: Array<{
    tool: string;
    calls: number;
    success: number;
    failure: number;
  }>;
  guardViolations: number;
}

export interface AttendanceMetrics {
  /**
   * Espera do cliente pelo humano no handoff: da IA passar pra equipe
   * (evento ai_ended/opened_for_human) até a 1ª resposta humana na sessão.
   */
  handoffToHuman: {
    handoffs: number;
    answeredByHuman: number;
    unanswered: number;
    medianMinutes: number | null;
    p95Minutes: number | null;
    under5min: number;
    under30min: number;
  };
  /**
   * Ciclo de encerramento do atendimento: quem fecha. Se a equipe assume mas
   * quase nunca encerra, a IA fecha sozinha por inatividade — sinal de que o
   * ciclo não é fechado pela ferramenta de Atendimento.
   */
  closure: {
    sessionsAssumedByHuman: number;
    closedByHuman: number;
    closedByAiInactivity: number;
    closedBySystemOther: number;
    humanReplyMessages: number;
    closedByHumanRate: number | null;
  };
  adoption: 'full' | 'partial' | 'not_used' | 'inactive';
  /**
   * Repasse automático da IA pra fila humana: quando a mensagem da IA fica sem
   * resposta do cliente por mais que o threshold configurado
   * (`reopen_ai_unanswered_settings`), a sessão volta pra fila (`open`). Um
   * threshold muito curto pode tirar da IA a chance de concluir sozinha —
   * qualquer pausa do cliente já joga a conversa pro humano.
   *
   * São dados CRUS: threshold configurado + reaberturas do dia. A leitura de
   * "está curto demais?" é interpretativa e fica a cargo do relatório (LLM),
   * que só levanta quando os números sustentarem. `null` quando o tenant não
   * usa o mecanismo (sem setting habilitado).
   */
  aiQueueHandoff: {
    thresholdMinutes: number;
    reopensToday: number;
    sessionsReopenedToday: number;
  } | null;
}

export interface HumanAttendanceMetrics {
  messages: {
    total: number;
    user: number;
    tenant: number;
    template: number;
    uniqueCustomers: number;
    uniqueSessions: number;
    firstActivityBrt: string | null;
    lastActivityBrt: string | null;
  };
  peakHour: { hourBrt: number; count: number } | null;
  responseTime: {
    sessionsWithUserMsg: number;
    sessionsWithTeamReply: number;
    unansweredSessions: number;
    medianMinutes: number | null;
    p95Minutes: number | null;
    under5min: number;
    under30min: number;
  };
  unanswered: {
    customersWithoutAnyReply: number;
  };
  team: {
    activeAttendants: number;
    distribution: Array<{
      userId: string | null;
      name: string | null;
      email: string | null;
      messagesSent: number;
    }>;
  };
}

export interface CollectedMetricsBase {
  reportDate: string;
  tenantId: string;
  tenantName: string | null;
  channels: {
    whatsapp: boolean;
    instagram: boolean;
    whatsappNumber: string | null;
    whatsappName: string | null;
    instagramHandle: string | null;
  };
  conversationSamples: SampledConversations;
  collectedAt: string;
}

export interface CollectedMetricsAi extends CollectedMetricsBase {
  mode: 'ai';
  desenrola: DesenrolaMetrics;
  workflow: WorkflowMetrics;
  attendance: AttendanceMetrics;
}

export interface CollectedMetricsHuman extends CollectedMetricsBase {
  mode: 'human';
  humanAttendance: HumanAttendanceMetrics;
}

export type CollectedMetrics = CollectedMetricsAi | CollectedMetricsHuman;
