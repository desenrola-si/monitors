# desenrola-monitors

Projeto independente pra crons de monitoramento e relatórios. Deploy no Railway.

## Stack

- TypeScript + Node 20+
- **Inversify** (DI 100% OO via decorators)
- **node-cron** (schedule interno do modo daemon)
- **pg** (Postgres direto, sem ORM)
- **pino** (logger estruturado)
- **axios** (webhook Google Chat)
- **tsx** (rodar TS direto, sem build em dev)

## Setup local

```bash
pnpm install
cp .env.example .env
# preencher .env com DESENROLA_DB_URL, WORKFLOW_PROCESSOR_DB_URL, GOOGLE_CHAT_WEBHOOK

pnpm list                 # ver jobs disponíveis
pnpm dev heartbeat        # roda 1 job ad-hoc
pnpm daemon               # roda daemon com todos os crons
```

## Adicionar novo cron

3 passos:

1. Criar `src/jobs/<nome>.ts` extendendo `Job`:

```ts
import { injectable, inject } from 'inversify';
import { Job } from '../lib/job.js';
import { TYPES } from '../lib/types.js';
import { Database } from '../lib/database.js';
import { Notifier } from '../lib/notifier.js';

@injectable()
export class MeuJob extends Job {
  readonly name = 'meu-job';
  readonly description = 'O que ele faz';
  readonly schedule = '*/10 * * * *';

  constructor(
    @inject(TYPES.Database) private readonly db: Database,
    @inject(TYPES.Notifier) private readonly notifier: Notifier,
  ) {
    super();
  }

  async run(): Promise<void> {
    const rows = await this.db.query(`SELECT ...`);
    if (rows.length) await this.notifier.googleChat(`Alerta: ...`);
  }
}
```

2. Importar e adicionar em `src/jobs/index.ts`:

```ts
import { MeuJob } from './meu-job.js';
export const JOB_CLASSES = [HeartbeatJob, MeuJob];
```

3. Rodar `pnpm dev --list` pra confirmar que apareceu.

## Modos de deploy na Railway

### Daemon (recomendado pra muitos crons)

1 service sempre-on com todos os crons internos.

```
Settings → Start Command: node dist/daemon.js
Settings → Cron Schedule: (deixa vazio)
```

Custo: ~$5/mês mínimo (service sempre rodando). Visibilidade: 1 log único pra todos os crons.

### Cron one-shot (recomendado pra poucos crons grandes)

1 service Railway por cron, agendado externamente.

```
Settings → Start Command: node dist/cli.js <nome-do-job>
Settings → Cron Schedule: 0 6 * * *
```

Custo: só pelo tempo de execução. Visibilidade: dashboard separado por cron.

Os 2 modos coexistem — você decide por cron qual usar.

## Estrutura

```
src/
├── lib/
│   ├── types.ts       Symbols Inversify + tipos compartilhados
│   ├── logger.ts      Pino wrapper (@injectable)
│   ├── database.ts    Pool pg lazy por DB
│   ├── notifier.ts    Google Chat webhook
│   ├── job.ts         abstract class Job
│   └── container.ts   buildContainer() — wires tudo
├── jobs/
│   ├── index.ts       JOB_CLASSES + helpers
│   └── heartbeat.ts   Job dummy (remover quando outros estiverem ok)
├── cli.ts             Entry one-shot: roda 1 job e sai
└── daemon.ts          Entry sempre-on: node-cron registra tudo
```

## Convenções

- **1 classe por arquivo** pra jobs.
- **Cron strings em BRT** (timezone configurado por job, default America/Sao_Paulo).
- **Jobs idempotentes**: rodar 2x dá o mesmo resultado.
- **Erros não derrubam daemon** — try/catch interno, segue pros outros jobs.
- **Logger estruturado**: `logger.info({ job: 'x', metric: 42 }, 'msg')` em vez de string concatenada.

## Próximos jobs sugeridos

- `daily-reports` — portar de `Backend/desenrola-restaurant-reservation-api/scripts/daily-reports/`
- `frustration-monitor` — equivalente TS do `Tools/cutoff-monitor/monitor.py`
- `workflow-failure-alert` — detecta execuções `failed` em PROD nas últimas X horas
- `dm-response-not-delivered` — detecta callbacks recebidos sem agent_message subsequente
