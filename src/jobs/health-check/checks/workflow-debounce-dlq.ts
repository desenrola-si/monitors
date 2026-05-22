import { Check, CheckContext, CheckResult } from '../check.js';

const MIN_OCCURRENCES = 1;

/**
 * Detecta entradas não resolvidas na tabela workflow_debounce_dlq (DB
 * desenrola). O backend escreve nessa tabela quando o BullMQ esgota as N
 * tentativas de processar um grupo de mensagens — significa que o cliente
 * mandou mensagem mas a IA não respondeu mesmo após retry.
 *
 * Cada row sem resolved_at é um caso aberto que precisa de ação humana
 * (resposta manual ao cliente + investigação do erro persistente).
 *
 * Severidade:
 * - 1-2 entradas pendentes → warning
 * - 3+ entradas → critical (algo sistêmico está falhando)
 */
export class WorkflowDebounceDlqCheck implements Check {
  readonly code = 'workflow_debounce_dlq';
  readonly alertTypeCode = 'workflow_debounce_dlq' as const;
  readonly description =
    'Grupos de mensagens parados na DLQ do debounce do backend';

  async run(ctx: CheckContext): Promise<CheckResult[]> {
    const rows = await ctx.db.query<{
      tenant_id: string;
      tenant_name: string | null;
      pending_count: string;
      oldest_failed_brt: string;
      sample_error: string;
      sample_channel: string;
    }>(
      `
      SELECT
        dlq.tenant_id,
        t.name AS tenant_name,
        COUNT(*)::text AS pending_count,
        TO_CHAR(
          (MIN(dlq.first_failed_at) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo',
          'DD/MM HH24:MI'
        ) AS oldest_failed_brt,
        (
          SELECT LEFT(d2.last_error, 80)
          FROM workflow_debounce_dlq d2
          WHERE d2.tenant_id = dlq.tenant_id
            AND d2.resolved_at IS NULL
          ORDER BY d2.last_failed_at DESC
          LIMIT 1
        ) AS sample_error,
        (
          SELECT d2.channel
          FROM workflow_debounce_dlq d2
          WHERE d2.tenant_id = dlq.tenant_id
            AND d2.resolved_at IS NULL
          ORDER BY d2.last_failed_at DESC
          LIMIT 1
        ) AS sample_channel
      FROM workflow_debounce_dlq dlq
      LEFT JOIN tenants t ON t.id::text = dlq.tenant_id
      WHERE dlq.resolved_at IS NULL
      GROUP BY dlq.tenant_id, t.name
      HAVING COUNT(*) >= ${MIN_OCCURRENCES}
      ORDER BY COUNT(*) DESC
      `,
      [],
      'desenrola',
    );

    return rows.map<CheckResult>((r) => {
      const count = Number(r.pending_count);
      const severity = count >= 3 ? 'critical' : 'warning';
      const label = r.tenant_name ?? r.tenant_id;
      return {
        tenantId: r.tenant_id,
        tenantName: r.tenant_name,
        severity,
        metricValue: count,
        payload: {
          pending_count: count,
          oldest_failed_brt: r.oldest_failed_brt,
          sample_error: r.sample_error,
          sample_channel: r.sample_channel,
        },
        notificationText:
          `${severity === 'critical' ? '🔴' : '🟡'} *${label}* — ` +
          `${count} grupo(s) na DLQ do debounce (${r.sample_channel}), ` +
          `mais antigo desde ${r.oldest_failed_brt} BRT. ` +
          `Último erro: "${r.sample_error}". Resposta manual + investigação.`,
      };
    });
  }
}
