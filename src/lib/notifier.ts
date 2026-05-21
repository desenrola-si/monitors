import { injectable, inject } from 'inversify';
import axios from 'axios';
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
      await axios.post(url, { text }, { timeout: 10_000 });
    } catch (err) {
      this.logger.error(
        { err: (err as Error).message },
        'Falha ao notificar Google Chat',
      );
    }
  }
}
