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
}

export interface CollectedMetricsHuman extends CollectedMetricsBase {
  mode: 'human';
  humanAttendance: HumanAttendanceMetrics;
}

export type CollectedMetrics = CollectedMetricsAi | CollectedMetricsHuman;
