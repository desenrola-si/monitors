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

  /**
   * Aciona o sre-agent (Zezinho) via webhook, no formato que ele espera
   * (POST /webhooks/grafana — o endpoint aceita qualquer POST nesse formato,
   * não precisa vir do Grafana). Usado para eventos de domínio detectados via
   * banco (ex: rajada de envio) dispararem investigação automática. O `repo`
   * aponta o repositório da CAUSA, não o monitors. Bearer autentica a requisição.
   * Erros não propagam (side-effect, como googleChat).
   */
  async sreAgent(alert: {
    alertname: string;
    repo: string;
    fingerprint: string;
    summary: string;
    description: string;
  }): Promise<void> {
    const url = process.env.SRE_AGENT_WEBHOOK_URL;
    const secret = process.env.SRE_AGENT_WEBHOOK_SECRET;
    if (!url || !secret) {
      this.logger.warn(
        'SRE_AGENT_WEBHOOK_URL/SECRET não configurado — skip acionar sre-agent',
      );
      return;
    }
    try {
      await axios.post(
        url,
        {
          alerts: [
            {
              status: 'firing',
              fingerprint: alert.fingerprint,
              labels: { alertname: alert.alertname, repo: alert.repo },
              annotations: {
                summary: alert.summary,
                description: alert.description,
              },
            },
          ],
        },
        {
          timeout: 10_000,
          headers: {
            Authorization: `Bearer ${secret}`,
            'Content-Type': 'application/json',
          },
        },
      );
    } catch (err) {
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
        },
        'Falha ao acionar sre-agent',
      );
    }
  }
}
