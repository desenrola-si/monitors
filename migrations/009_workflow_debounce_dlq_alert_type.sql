-- ============================================================
-- 009_workflow_debounce_dlq_alert_type.sql
-- ============================================================
-- Alert type novo: quando um grupo de mensagens no debounce do backend
-- esgota retries (3 attempts com backoff exponencial) e vai pra DLQ
-- persistente (tabela workflow_debounce_dlq no DB desenrola).
--
-- Cobre os silent errors #1, #2, #3, #6, #7 (ver
-- docs/DEBOUNCE_SETTIMEOUT_TECH_DEBT.md no backend).

INSERT INTO alert_types (code, description) VALUES
  ('workflow_debounce_dlq',
   'Grupo de mensagens do debounce esgotou retries e está parado na DLQ — intervenção manual necessária')
ON CONFLICT (code) DO NOTHING;
