-- ============================================================
-- 013_multi_account_compliance_gap_alert_type.sql
-- ============================================================
-- Alert quando customers / message_logs / service_sessions são criados
-- sem origin/origin_id na janela de 5min — indica caller que não está
-- propagando a conta de origem.
--
-- Bloqueia o critério pra apertar strict no CustomerLookupService
-- (remover fallback). Ver project_multi_account_roadmap e
-- project_customer_lookup_legacy_warn.

INSERT INTO alert_types (code, description) VALUES
  ('multi_account_compliance_gap',
   'Customer/message_log/service_session criado sem origin/origin_id em tenant multi-WABA — caller não está propagando a conta de origem')
ON CONFLICT (code) DO NOTHING;
