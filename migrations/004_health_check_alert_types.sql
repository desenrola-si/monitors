-- ============================================================
-- 004_health_check_alert_types.sql — alert types do HealthCheckJob
-- ============================================================
-- Adiciona 4 novos tipos de alerta detectados pelo health-check
-- e um status novo "resolved_auto" pra quando a condição volta ao
-- normal automaticamente (não foi humano nem IA).

INSERT INTO alert_types (code, description) VALUES
  ('message_delivery_failure', 'Mensagens do agente IA falhando no envio (delivery_status=FAILED) em volume anormal'),
  ('workflow_failure_burst',   'Execuções de workflow falhando em sequência — pode indicar provider lento, schema mudou, etc'),
  ('wa_24h_window_closed',     'Tentativas de mandar mensagem WhatsApp fora da janela de 24h aberta pelo cliente'),
  ('ig_dm_silent_drop',        'Mensagem Instagram DM marcada como enviada pelo sistema mas sem confirmação do provider')
ON CONFLICT (code) DO NOTHING;

INSERT INTO alert_statuses (code) VALUES
  ('resolved_auto')
ON CONFLICT (code) DO NOTHING;
