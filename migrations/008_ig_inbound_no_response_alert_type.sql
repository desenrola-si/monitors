-- ============================================================
-- 008_ig_inbound_no_response_alert_type.sql
-- ============================================================
-- Alert type novo: detecta Instagram DM inbound sem resposta em [5min, 1h]
-- de tenants com IA configurada. Captura silent drops do pipeline de
-- debounce/workflow (ver backend docs/DEBOUNCE_SETTIMEOUT_TECH_DEBT.md).

INSERT INTO alert_types (code, description) VALUES
  ('ig_inbound_no_response',
   'Cliente Instagram DM sem resposta enquanto IA deveria estar ativa')
ON CONFLICT (code) DO NOTHING;
