import { desenrolaPool } from './db.js';

export type TenantMode = 'ai' | 'human';

export interface ActiveTenant {
  id: string;
  name: string | null;
  hasWhatsapp: boolean;
  hasInstagram: boolean;
  workflowSlug: string | null;
  whatsappNumber: string | null;
  whatsappName: string | null;
  instagramHandle: string | null;
  /**
   * 'ai'    — workflow_slug ativo e não-placeholder → pipeline da IA
   * 'human' — sem workflow_slug ativo OU slug placeholder (TODO*) →
   *           pipeline de relatório do atendimento humano da equipe
   */
  mode: TenantMode;
}

function classifyMode(workflowSlug: string | null): TenantMode {
  if (!workflowSlug) return 'human';
  if (/^TODO/i.test(workflowSlug.trim())) return 'human';
  return 'ai';
}

function hydrate<T extends Omit<ActiveTenant, 'mode'>>(row: T): ActiveTenant {
  return { ...row, mode: classifyMode(row.workflowSlug) } as ActiveTenant;
}

/**
 * Lista TODOS os tenants com pelo menos uma conta ativa (whatsapp/instagram).
 * Quem tem workflow_slug ativo + não-placeholder vira mode='ai'; resto vira
 * mode='human' — usado pelo pipeline de relatório do atendimento humano.
 *
 * Prioridade pra escolher o slug quando o tenant tem mais de um:
 *   1) WhatsApp (canal principal hoje)
 *   2) Instagram DM (conversa privada)
 *   3) Instagram COMMENTS (interação pública)
 */
export async function listActiveTenants(): Promise<ActiveTenant[]> {
  const { rows } = await desenrolaPool.query<Omit<ActiveTenant, 'mode'>>(`
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
        CASE f.name WHEN 'DM' THEN 1 WHEN 'COMMENTS' THEN 2 ELSE 3 END AS priority
      FROM instagram_account_features iaf
      INNER JOIN instagram_accounts ia ON ia.id = iaf.instagram_account_id
      INNER JOIN instagram_features f ON f.id = iaf.instagram_feature_id
      WHERE ia.is_active = true
        AND iaf.is_active = true
        AND iaf.is_workflow_slug_enabled = true
        AND iaf.workflow_slug IS NOT NULL
    ),
    -- Inclui também tenants que TÊM conta ativa mas SEM workflow_slug — esses
    -- viram mode='human' lá em cima. Hoje cobre placeholders TODO* e tenants
    -- 100% humanos.
    active_with_channel AS (
      SELECT DISTINCT tenant_id FROM whatsapp_accounts WHERE is_active = true
      UNION
      SELECT DISTINCT tenant_id FROM instagram_accounts WHERE is_active = true
    )
    SELECT
      t.id::text                                                                AS id,
      t.name                                                                    AS name,
      EXISTS (
        SELECT 1 FROM whatsapp_accounts wa
        WHERE wa.tenant_id = t.id AND wa.is_active = true
      )                                                                         AS "hasWhatsapp",
      EXISTS (
        SELECT 1 FROM instagram_accounts ia
        WHERE ia.tenant_id = t.id AND ia.is_active = true
      )                                                                         AS "hasInstagram",
      (
        SELECT s.workflow_slug FROM account_slugs s
        WHERE s.tenant_id = t.id
        ORDER BY s.priority, s.workflow_slug
        LIMIT 1
      )                                                                         AS "workflowSlug",
      (SELECT display_phone_number FROM whatsapp_accounts wa WHERE wa.tenant_id = t.id AND wa.is_active = true LIMIT 1) AS "whatsappNumber",
      (SELECT verified_name FROM whatsapp_accounts wa WHERE wa.tenant_id = t.id AND wa.is_active = true LIMIT 1) AS "whatsappName",
      (SELECT COALESCE('@' || NULLIF(username, ''), account_name) FROM instagram_accounts ia WHERE ia.tenant_id = t.id AND ia.is_active = true LIMIT 1) AS "instagramHandle"
    FROM tenants t
    INNER JOIN active_with_channel a ON a.tenant_id = t.id
    ORDER BY t.name NULLS LAST, t.id
  `);
  return rows.map(hydrate);
}

export async function getTenantById(
  tenantId: string,
): Promise<ActiveTenant | null> {
  const { rows } = await desenrolaPool.query<Omit<ActiveTenant, 'mode'>>(
    `
      WITH account_slugs AS (
        SELECT workflow_slug, 0 AS priority
        FROM whatsapp_accounts
        WHERE tenant_id = $1
          AND is_active = true
          AND is_workflow_slug_enabled = true
          AND workflow_slug IS NOT NULL
        UNION ALL
        SELECT
          iaf.workflow_slug,
          CASE f.name WHEN 'DM' THEN 1 WHEN 'COMMENTS' THEN 2 ELSE 3 END AS priority
        FROM instagram_account_features iaf
        INNER JOIN instagram_accounts ia ON ia.id = iaf.instagram_account_id
        INNER JOIN instagram_features f ON f.id = iaf.instagram_feature_id
        WHERE ia.tenant_id = $1
          AND ia.is_active = true
          AND iaf.is_active = true
          AND iaf.is_workflow_slug_enabled = true
          AND iaf.workflow_slug IS NOT NULL
      ),
      has_active_channel AS (
        SELECT 1 WHERE EXISTS (
          SELECT 1 FROM whatsapp_accounts WHERE tenant_id = $1 AND is_active = true
        ) OR EXISTS (
          SELECT 1 FROM instagram_accounts WHERE tenant_id = $1 AND is_active = true
        )
      )
      SELECT
        t.id::text          AS id,
        t.name              AS name,
        EXISTS (
          SELECT 1 FROM whatsapp_accounts wa
          WHERE wa.tenant_id = t.id AND wa.is_active = true
        )                                                                       AS "hasWhatsapp",
        EXISTS (
          SELECT 1 FROM instagram_accounts ia
          WHERE ia.tenant_id = t.id AND ia.is_active = true
        )                                                                       AS "hasInstagram",
        (SELECT workflow_slug FROM account_slugs ORDER BY priority, workflow_slug LIMIT 1) AS "workflowSlug",
        (SELECT display_phone_number FROM whatsapp_accounts wa WHERE wa.tenant_id = t.id AND wa.is_active = true LIMIT 1) AS "whatsappNumber",
        (SELECT verified_name FROM whatsapp_accounts wa WHERE wa.tenant_id = t.id AND wa.is_active = true LIMIT 1) AS "whatsappName",
        (SELECT COALESCE('@' || NULLIF(username, ''), account_name) FROM instagram_accounts ia WHERE ia.tenant_id = t.id AND ia.is_active = true LIMIT 1) AS "instagramHandle"
      FROM tenants t
      WHERE t.id = $1
        AND EXISTS (SELECT 1 FROM has_active_channel)
      LIMIT 1
    `,
    [tenantId],
  );
  return rows[0] ? hydrate(rows[0]) : null;
}
