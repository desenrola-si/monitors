import { config } from '../config.js';
import { ActiveTenant } from '../tenants.js';
import { collectDesenrolaMetrics } from './desenrola.js';
import { sampleConversations } from './conversations.js';
import { collectWorkflowMetrics } from './workflow.js';
import { collectHumanAttendanceMetrics } from './human-attendance.js';
import { CollectedMetrics } from './types.js';

const baseChannels = (tenant: ActiveTenant) => ({
  whatsapp: tenant.hasWhatsapp,
  instagram: tenant.hasInstagram,
  whatsappNumber: tenant.whatsappNumber,
  whatsappName: tenant.whatsappName,
  instagramHandle: tenant.instagramHandle,
});

export async function collectMetrics(
  tenant: ActiveTenant,
  reportDate: string,
): Promise<CollectedMetrics> {
  if (tenant.mode === 'human') {
    const [humanAttendance, conversationSamples] = await Promise.all([
      collectHumanAttendanceMetrics(tenant.id, reportDate),
      sampleConversations(tenant.id, reportDate, config.conversationSamples.n),
    ]);

    return {
      mode: 'human',
      reportDate,
      tenantId: tenant.id,
      tenantName: tenant.name,
      channels: baseChannels(tenant),
      humanAttendance,
      conversationSamples,
      collectedAt: new Date().toISOString(),
    };
  }

  const [desenrola, workflow, conversationSamples] = await Promise.all([
    collectDesenrolaMetrics(tenant.id, reportDate),
    collectWorkflowMetrics(tenant.id, reportDate),
    sampleConversations(tenant.id, reportDate, config.conversationSamples.n),
  ]);

  return {
    mode: 'ai',
    reportDate,
    tenantId: tenant.id,
    tenantName: tenant.name,
    channels: baseChannels(tenant),
    desenrola,
    workflow,
    conversationSamples,
    collectedAt: new Date().toISOString(),
  };
}
