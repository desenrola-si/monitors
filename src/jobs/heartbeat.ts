import { injectable, inject } from 'inversify';
import { Job } from '../lib/job.js';
import { TYPES } from '../lib/types.js';
import { Logger } from '../lib/logger.js';
import { Notifier } from '../lib/notifier.js';

/**
 * Job dummy pra validar deploy + cron. Loga "olá" e (opcionalmente)
 * notifica Google Chat. Remover quando os jobs reais estiverem rodando.
 */
@injectable()
export class HeartbeatJob extends Job {
  readonly name = 'heartbeat';
  readonly description = 'Loga "olá" pra validar deploy/cron';
  readonly schedule = '* * * * *'; // cada minuto

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.Notifier) private readonly notifier: Notifier,
  ) {
    super();
  }

  async run(): Promise<void> {
    this.logger.info(
      { job: this.name, ts: new Date().toISOString() },
      'olá do heartbeat',
    );
    if (process.env.HEARTBEAT_NOTIFY === 'true') {
      await this.notifier.googleChat(
        `💓 desenrola-monitors heartbeat ${new Date().toISOString()}`,
      );
    }
  }
}
