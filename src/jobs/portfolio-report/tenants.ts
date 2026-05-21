import { Database } from '../../lib/database.js';
import { PortfolioTenant } from './types.js';

/**
 * Lista TODOS os tenants com pelo menos uma conta ativa (WA ou IG) —
 * incluindo os que ainda estão com workflow_slug placeholder (TODO*).
 *
 * Esses placeholders viram cards no relatório marcados como
 * `ai_configured=false` — útil pra você ver quem está ativo mas sem
 * prompt configurado (oportunidade de ativação).
 *
 * Prioridade pra escolher o slug quando o tenant tem mais de um:
 *   1) WhatsApp
 *   2) Instagram DM
 *   3) Instagram COMMENTS
 */
export async function listPortfolioTenants(
  db: Database,
): Promise<PortfolioTenant[]> {
  const rows = await db.query<{
    id: string;
    name: string | null;
    workflow_slug: string | null;
  }>(
    `
    WITH account_slugs AS (
      SELECT tenant_id, workflow_slug, 0 AS priority
      FROM whatsapp_accounts
      WHERE is_active = true
        AND is_workflow_slug_enabled = true
        AND workflow_slug IS NOT NULL
      UNION ALL
      SELECT
        ia.tenant_id,
        iaf.workflow_slug,
        CASE f.name WHEN 'DM' THEN 1 WHEN 'COMMENTS' THEN 2 ELSE 3 END
      FROM instagram_account_features iaf
      INNER JOIN instagram_accounts ia ON ia.id = iaf.instagram_account_id
      INNER JOIN instagram_features f ON f.id = iaf.instagram_feature_id
      WHERE ia.is_active = true
        AND iaf.is_active = true
        AND iaf.is_workflow_slug_enabled = true
        AND iaf.workflow_slug IS NOT NULL
    ),
    -- Inclui também tenants que TÊM conta ativa mas SEM slug definido
    active_with_account AS (
      SELECT DISTINCT tenant_id FROM whatsapp_accounts WHERE is_active = true
      UNION
      SELECT DISTINCT tenant_id FROM instagram_accounts WHERE is_active = true
    )
    SELECT
      t.id::text AS id,
      t.name,
      (
        SELECT s.workflow_slug FROM account_slugs s
        WHERE s.tenant_id = t.id
        ORDER BY s.priority, s.workflow_slug
        LIMIT 1
      ) AS workflow_slug
    FROM tenants t
    INNER JOIN active_with_account a ON a.tenant_id = t.id
    ORDER BY t.name NULLS LAST, t.id
    `,
    [],
    'desenrola',
  );

  return rows.map<PortfolioTenant>((r) => {
    const slug = r.workflow_slug;
    const isPlaceholder = slug === null || /^TODO/i.test(slug);
    return {
      id: r.id,
      name: r.name,
      workflowSlug: slug,
      isPlaceholder,
    };
  });
}
