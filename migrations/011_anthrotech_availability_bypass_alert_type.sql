-- ============================================================
-- 011_anthrotech_availability_bypass_alert_type.sql
-- ============================================================
-- Alert type novo: quando a IA do workflow anthrotech (amilgas-ipg, etc)
-- confirma agendamento de data específica sem ter chamado a tool
-- get_anthrotech_availability antes na conversa.
--
-- Cenário típico (incidente Maria Medeiros — 30/05/2026):
-- - Cliente pede agendamento "amanhã"
-- - IA usa regra estática do prompt ("sexta antes de 16:30 → sábado")
-- - Confirma agendamento sem consultar capacidade real
-- - Operação descobre depois que a vaga já tinha esgotado
--
-- Pós-hotfix (1º jun 2026): prompt agora exige get_anthrotech_availability
-- antes de propor data + backend cruza Anthrotech + validator local. Esse
-- monitor garante que o comportamento se mantém — se aparecer alerta, é
-- regressão do prompt ou bug do enforcement.

INSERT INTO alert_types (code, description) VALUES
  ('anthrotech_scheduled_without_availability_check',
   'IA confirmou agendamento de vistoria/reinspeção sem ter chamado get_anthrotech_availability antes')
ON CONFLICT (code) DO NOTHING;
