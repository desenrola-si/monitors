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

export interface CollectedMetrics {
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
  desenrola: DesenrolaMetrics;
  workflow: WorkflowMetrics;
  conversationSamples: SampledConversations;
  collectedAt: string;
}
