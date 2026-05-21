import { injectable, inject } from 'inversify';
import axios, { AxiosError } from 'axios';
import { TYPES } from './types.js';
import { Logger } from './logger.js';

/**
 * Wrapper de notificações. Hoje só Google Chat — adicionar Slack/email
 * quando necessário. Erros de envio são logados mas não propagam (notify
 * é side-effect, falhar nele não deve derrubar o job).
 */
@injectable()
export class Notifier {
  constructor(@inject(TYPES.Logger) private readonly logger: Logger) {}

  async googleChat(text: string): Promise<void> {
    const url = process.env.GOOGLE_CHAT_WEBHOOK;
    if (!url) {
      this.logger.warn('GOOGLE_CHAT_WEBHOOK não configurado — skip notify');
      return;
    }
    try {
      await axios.post(
        url,
        { text },
        {
          timeout: 10_000,
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        },
      );
    } catch (err) {
      // Axios anexa response em err.response quando o servidor respondeu
      // com 4xx/5xx — extraímos status + body pra entender o motivo (ex:
      // Google Chat retorna { error: { code, message, status, details } }).
      const axiosErr = err as AxiosError;
      const status = axiosErr.response?.status;
      const body =
        typeof axiosErr.response?.data === 'object'
          ? JSON.stringify(axiosErr.response.data).slice(0, 600)
          : String(axiosErr.response?.data ?? '').slice(0, 600);

      this.logger.error(
        {
          err: axiosErr.message,
          ...(status !== undefined && { status }),
          ...(body && { body }),
          // primeiros 100 chars da URL pra ver se o token chegou bem
          urlPrefix: url.slice(0, 100),
        },
        'Falha ao notificar Google Chat',
      );
    }
  }
}
