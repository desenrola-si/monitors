-- ============================================================
-- 007_alerts_tenant_id_text.sql — tenant_id UUID → TEXT
-- ============================================================
-- Motivo: existem tenants com IDs não-UUID (ex: 'desenrola-headquarters',
-- usado como GENERATE_PROMPT_TENANT_ID no instagram-dm-setup do backend).
-- Os checks do health-check leem tenant_id como text de message_logs e
-- afins e tentam inserir em `alerts.tenant_id UUID` → INSERT explode com
-- "invalid input syntax for type uuid". Como o insertOpen do AlertsRepository
-- é chamado FORA do try/catch por-check em HealthCheckJob.run, o erro
-- borbulha e marca o job como failed.
--
-- Trocar pra TEXT alinha com:
--   - daily_tenant_reports.tenant_id (já é TEXT no backend)
--   - portfolio_snapshots.tenant_id (TEXT na migration nova do backend)
--   - todas as queries dos checks que já fazem t.id::text = X.tenant_id
--
-- Cast UUID → TEXT é seguro: todo UUID válido é uma string válida.

ALTER TABLE alerts
  ALTER COLUMN tenant_id TYPE TEXT
  USING tenant_id::text;

ALTER TABLE health_check_findings
  ALTER COLUMN tenant_id TYPE TEXT
  USING tenant_id::text;
