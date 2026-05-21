import { injectable } from 'inversify';

/**
 * Classe abstrata pra todo job. Subclasses declaram `name`/`description`/
 * `schedule` (cron string em BRT por padrão) e implementam `run()`.
 *
 * O `schedule` é doc + ativo no modo daemon (lido pelo node-cron). No modo
 * CLI one-shot (Railway agendando externamente), o schedule fica como
 * referência mas Railway controla quando dispara.
 */
@injectable()
export abstract class Job {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly schedule: string;
  readonly timezone: string = 'America/Sao_Paulo';

  abstract run(): Promise<void>;
}
