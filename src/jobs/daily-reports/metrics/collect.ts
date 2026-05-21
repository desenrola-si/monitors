import { config } from '../config.js';
import { ActiveTenant } from '../tenants.js';
import { collectDesenrolaMetrics } from './desenrola.js';
import { sampleConversations } from './conversations.js';
import { collectWorkflowMetrics } from './workflow.js';
import { CollectedMetrics } from './types.js';

export async function collectMetrics(
  tenant: ActiveTenant,
  reportDate: string,
): Promise<CollectedMetrics> {
  const [desenrola, workflow, conversationSamples] = await Promise.all([
    collectDesenrolaMetrics(tenant.id, reportDate),
    collectWorkflowMetrics(tenant.id, reportDate),
    sampleConversations(tenant.id, reportDate, config.conversationSamples.n),
  ]);

  return {
    reportDate,
    tenantId: tenant.id,
    tenantName: tenant.name,
    channels: {
      whatsapp: tenant.hasWhatsapp,
      instagram: tenant.hasInstagram,
      whatsappNumber: tenant.whatsappNumber,
      whatsappName: tenant.whatsappName,
      instagramHandle: tenant.instagramHandle,
    },
    desenrola,
    workflow,
    conversationSamples,
    collectedAt: new Date().toISOString(),
  };
}
