import { desenrolaPool } from './db.js';

/**
 * Lê o conteúdo da memória do tenant em tenant_memory.content.
 * Retorna string vazia se não houver row (tenant novo).
 */
export async function getTenantMemory(tenantId: string): Promise<string> {
  const { rows } = await desenrolaPool.query<{ content: string }>(
    `SELECT content FROM tenant_memory WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  );
  return rows[0]?.content?.trim() ?? '';
}
