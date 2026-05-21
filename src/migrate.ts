import 'dotenv/config';
import { Client } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

/**
 * Runner de migrations contra MONITORS_DB_URL. Sem framework — SQL puro
 * com tracking em `_migrations`. Executa em ordem alfabética (use prefixo
 * numérico `001_`, `002_`).
 *
 * Estratégia:
 *   1. Garante que `_migrations` existe
 *   2. Lista arquivos *.sql da pasta migrations/
 *   3. Pra cada um: se não está em `_migrations`, executa numa transação
 *      e insere o registro
 *
 * Idempotente: rodar de novo skipa o que já foi aplicado.
 */
async function main(): Promise<void> {
  const url = process.env.MONITORS_DB_URL;
  if (!url) {
    throw new Error('MONITORS_DB_URL não configurado');
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows: applied } = await client.query<{ name: string }>(
    `SELECT name FROM _migrations`,
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  let executed = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`✓ ${file} (já aplicado)`);
      continue;
    }

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    console.log(`→ ${file} aplicando…`);

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO _migrations (name) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      executed++;
      console.log(`✓ ${file}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error(`✗ ${file} falhou:`, (err as Error).message);
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log(`\nMigrations concluídas (${executed} novas, ${files.length - executed} já estavam aplicadas)`);
}

main().catch((err) => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
