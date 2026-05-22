-- ============================================================
-- 010_resolve_ig_inbound_no_response_alerts.sql
-- ============================================================
-- IgInboundNoResponseCheck foi desativado em favor do
-- WorkflowDebounceDlqCheck (sinal direto da DLQ).
--
-- Resolve TODOS os alerts open desse tipo pra eles não ficarem órfãos
-- (sem o check no array do HealthCheckJob, eles nunca seriam
-- auto-resolved naturalmente).

UPDATE alerts
SET status_id = (SELECT id FROM alert_statuses WHERE code = 'resolved_auto'),
    resolved_at = NOW(),
    resolution_note = 'Check IgInboundNoResponseCheck desativado — substituído por WorkflowDebounceDlqCheck'
WHERE status_id = (SELECT id FROM alert_statuses WHERE code = 'open')
  AND alert_type_id = (SELECT id FROM alert_types WHERE code = 'ig_inbound_no_response');
