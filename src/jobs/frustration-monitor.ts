import { injectable, inject } from 'inversify';
import { Job } from '../lib/job.js';
import { TYPES } from '../lib/types.js';
import { Logger } from '../lib/logger.js';
import { Database } from '../lib/database.js';
import { Notifier } from '../lib/notifier.js';

const TENANT_ID = 'b14ddbae-1543-46b5-b3fa-e314c10c31b9'; // Amilgás
const TENANT_NAME = 'Amilgás';

// Regex de sinais de frustração / contestação. Mantido idêntico ao monitor.py
// (versão original que rodava no Mac do Thiago).
const FRUSTRATION_SIGNAL_REGEX =
  'n[ãa]o\\s+entend(o|i|emos)|t[áa]\\s+errado|est[áa]\\s+errado|' +
  '(vcs|voc[êe]s|vc)\\s+n[ãa]o\\s+(tem|t[êe]m)|' +
  'n[ãa]o\\s+tinha\\s+(esses|estes|isso)|n[ãa]o\\s+procede|' +
  'n[ãa]o\\s+(é|e)\\s+isso|' +
  '(meu|minha)\\s+(marido|esposa|familiar|filh[oa])\\s+acompanhou|' +
  'houve\\s+troca|n[ãa]o\\s+(faz|tem)\\s+sentido|' +
  't[ôo]\\s+perdido|que\\s+confus[ãa]o|discordo|' +
  'laudo\\s+(errado|incorreto|n[ãa]o)|n[ãa]o\\s+bate|' +
  'isso\\s+(n[ãa]o|nao)\\s+funciona';

// Padrão de mensagem da IA oferecendo handoff humano
const IA_HANDOFF_REGEX =
  'transferir.*(atendente|humano)|atendente\\s+humano|' +
  'um\\s+atendente\\s+nosso|vou\\s+transferir|encaminhar.*atendente';

// Mensagem CURTA do cliente que indica aceitação/satisfação após o sinal de
// frustração — sinaliza que a IA esclareceu na sequência e o cliente concordou.
// Aplicado só pra mensagens com length < 30 pra não pegar "ok mas tá errado".
//
// Reduz falso positivo do caso Luciana/Amilgás (21/05): cliente disse "Não
// entendi, tá agendado ou não?", IA esclareceu, cliente respondeu "Ok".
const USER_ACK_REGEX =
  '^\\s*(ok|blz|beleza|valeu|obrigad[ao]s?|' +
  't[áa]\\s+(ok|bom|certo|joia|tranquilo)|' +
  'perfeito|certo|isso|entend[ai]|entendido|sim|' +
  'combinad[ao]|joia|legal|otimo|[óo]timo)[\\s!.…👍✅🙏]*$';

interface FrustrationRow {
  phone: string;
  first_signal_brt: string;
  signals: string;
}

function formatPhone(raw: string): string {
  // 5521980883176 → (21) 9 8088-3176
  if (raw.length === 13 && raw.startsWith('55')) {
    return `(${raw.slice(2, 4)}) ${raw.slice(4, 5)} ${raw.slice(5, 9)}-${raw.slice(9)}`;
  }
  return raw;
}

/**
 * Monitor que detecta conversas Amilgás onde o cliente sinaliza frustração
 * ou contestação e a IA NÃO escalou pra humano (e nenhum humano respondeu).
 *
 * Janela larga de 7 dias pra `NOT EXISTS` cobre "humano ATIVO" — evita falso
 * positivo quando cliente expressa confusão DURANTE atendimento humano em
 * andamento (caso Elisa Fulco / Vera / Ana Cláudia, mai/2026).
 *
 * Cache em memória: `seen` evita re-notificar o mesmo (phone, first_signal)
 * dentro da mesma execução do daemon. Restart do container limpa cache —
 * trade-off aceito (pode duplicar 1x após deploy, melhor que persistência).
 */
@injectable()
export class FrustrationMonitorJob extends Job {
  readonly name = 'frustration-monitor';
  readonly description = `Detecta frustração não escalada em ${TENANT_NAME}`;
  readonly schedule = '*/5 * * * *'; // cada 5 min

  private readonly seen = new Set<string>();

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.Database) private readonly db: Database,
    @inject(TYPES.Notifier) private readonly notifier: Notifier,
  ) {
    super();
  }

  async run(): Promise<void> {
    const log = this.logger.child({ job: this.name });
    const sinceUtc = new Date(Date.now() - 24 * 3600 * 1000);
    const handoffLookbackUtc = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const rows = await this.db.query<FrustrationRow>(
      `
      WITH frust AS (
        SELECT request_id, MIN(receivad_at) AS first_signal,
          array_agg(LEFT(message, 120) ORDER BY receivad_at) AS signals
        FROM message_logs
        WHERE tenant_id = $1
          AND receivad_at >= $2::timestamp
          AND origin = 'user'
          AND message ~* $3
        GROUP BY request_id
      )
      SELECT f.request_id AS phone,
        to_char(f.first_signal AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI:SS') AS first_signal_brt,
        array_to_string(f.signals, ' | ') AS signals
      FROM frust f
      WHERE NOT EXISTS (
        SELECT 1 FROM message_logs h
        WHERE h.tenant_id = $1
          AND h.request_id = f.request_id
          AND h.receivad_at >= $4::timestamp
          AND h.origin IN ('tenant', 'guard_handoff')
      )
      AND NOT EXISTS (
        SELECT 1 FROM message_logs i
        WHERE i.tenant_id = $1
          AND i.request_id = f.request_id
          AND i.receivad_at >= $4::timestamp
          AND i.origin = 'agent'
          AND i.message ~* $5
      )
      AND NOT EXISTS (
        -- Cliente respondeu OK curto em até 30min após o sinal → IA já esclareceu
        SELECT 1 FROM message_logs ack
        WHERE ack.tenant_id = $1
          AND ack.request_id = f.request_id
          AND ack.receivad_at > f.first_signal
          AND ack.receivad_at <= f.first_signal + INTERVAL '30 minutes'
          AND ack.origin = 'user'
          AND length(ack.message) < 30
          AND ack.message ~* $6
      )
      ORDER BY f.first_signal DESC
      `,
      [
        TENANT_ID,
        sinceUtc.toISOString(),
        FRUSTRATION_SIGNAL_REGEX,
        handoffLookbackUtc.toISOString(),
        IA_HANDOFF_REGEX,
        USER_ACK_REGEX,
      ],
    );

    log.info({ found: rows.length }, 'checagem concluída');

    let novos = 0;
    for (const row of rows) {
      const key = `frust::${row.phone}::${row.first_signal_brt}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      novos++;

      await this.notifier.googleChat(this.formatMessage(row));
      log.warn({ phone: row.phone, first_signal_brt: row.first_signal_brt }, 'alerta enviado');
    }

    if (novos === 0 && rows.length > 0) {
      log.info({ known: rows.length }, 'todos os sinais já notificados');
    } else if (rows.length === 0) {
      log.info('nada a alertar');
    } else {
      log.info({ novos, total: rows.length }, 'alertas processados');
    }
  }

  private formatMessage(row: FrustrationRow): string {
    const phone = formatPhone(row.phone);
    return (
      `🚨 *${TENANT_NAME} — Frustração/Contestação NÃO escalada*\n` +
      `*Cliente:* ${phone}\n` +
      `*1º sinal:* ${row.first_signal_brt} BRT\n` +
      `*Sinais detectados:*\n${row.signals.slice(0, 400)}\n\n` +
      `*Diagnóstico:* ⚠️ Cliente expressou confusão, frustração ou contestou ` +
      `laudo/vistoria, mas a IA não chamou \`request_human_intervention\` nem ` +
      `houve handoff humano até agora.\n\n` +
      `Ver conversa: https://app.desenrolasi.com.br/conversas/${row.phone}?tenantId=${TENANT_ID}`
    );
  }
}
