-- ============================================================
-- 012_customer_duplicate_wa_id_drift_alert_type.sql
-- ============================================================
-- Alert quando customer novo é criado com requester_id que difere
-- de um customer existente do mesmo tenant apenas pelo 9º dígito BR
-- (típico drift wa_id vs número normalizado do CSV).
--
-- Motivação: PR #571 (1º jun 2026) fez send-template gravar
-- MessageLog.request_id = wa_id da Meta em vez do número normalizado
-- que enviamos. Se o wa_id real diverge (+/− 9º dígito), customers
-- criados antes do fix não casam com a nova chave → criação de
-- customer duplicado na próxima interação.

INSERT INTO alert_types (code, description) VALUES
  ('customer_duplicate_wa_id_drift',
   'Customer novo criado com requester_id divergindo de existente apenas pelo 9º dígito BR — possível duplicação por mudança do wa_id como chave (PR #571)')
ON CONFLICT (code) DO NOTHING;
