import { injectable, inject } from 'inversify';
import { Job } from '../lib/job.js';
import { TYPES } from '../lib/types.js';
import { Logger } from '../lib/logger.js';
import { Database } from '../lib/database.js';

const TENANT_IDS: readonly string[] = [
  '18901ba9-2ba7-4a59-9155-40f5e5a98a11', // Livre Laser
  '21f78cdb-918c-4920-8547-b068a652f8b0', // LivreLaser2
];

/**
 * Força `customers.is_human = true` pra todos os clientes dos tenants
 * Livre Laser. O atendimento dessa operação é 100% humano e o relatório/UI
 * depende desse flag estar coerente — esse job mantém isso a cada 2 segundos.
 *
 * Filtro é idempotente: só toca rows com `is_human = false`, então 99% das
 * execuções são no-op (0 rows afetadas, 0 WAL).
 */
@injectable()
export class LivreLaserMarkCustomersHumanJob extends Job {
  readonly name = 'livre-laser-mark-customers-human';
  readonly displayName = 'Livre Laser — forçar customers como humanos';
  readonly description =
    'Mantém customers do Livre Laser/LivreLaser2 com is_human=true. Roda a cada 2s e só atualiza quando há customer novo ainda marcado como não-humano.';
  readonly schedule = '*/2 * * * * *';

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.Database) private readonly db: Database,
  ) {
    super();
  }

  async run(): Promise<void> {
    const log = this.logger.child({ job: this.name });

    const result = await this.db.query<{ id: string }>(
      `
        UPDATE customers
        SET is_human = true,
            is_human_at = COALESCE(is_human_at, NOW())
        WHERE tenant_id = ANY($1::text[])
          AND is_human = false
        RETURNING id
      `,
      [TENANT_IDS],
    );

    if (result.length === 0) {
      log.debug('Nenhum customer pra marcar como humano');
      return;
    }

    log.info(
      `Marcou ${result.length} customer(s) como humano(s) — ${result.map((r) => r.id).join(', ')}`,
    );
  }
}
