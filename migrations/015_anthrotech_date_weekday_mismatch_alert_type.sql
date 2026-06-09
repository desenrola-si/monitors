-- ============================================================
-- 015_anthrotech_date_weekday_mismatch_alert_type.sql
-- ============================================================
-- Alert type novo: mensagem da operação (IA/atendente/template) que cita
-- um dia-da-semana que NÃO corresponde à data informada na mesma frase.
--
-- Cenário típico (incidente Carolina — 06/06/2026):
-- - IA/template manda "sexta-feira, 06/06" mas 06/06/2026 é sábado
-- - Cliente se programa pelo dia da semana e/ou pela data divergente
-- - Resultado: "data agendada ≠ combinada" na percepção do cliente
--
-- Esse monitor varre mensagens recentes e alerta quando dia-da-semana e
-- data não batem — é o sinal observável e auto-contido do bug de geração
-- de data (não depende de fonte externa nem de comparar duas datas).

INSERT INTO alert_types (code, description) VALUES
  ('anthrotech_date_weekday_mismatch',
   'Mensagem cita dia-da-semana que não corresponde à data informada (ex.: "sexta, 06/06" quando 06/06 é sábado)')
ON CONFLICT (code) DO NOTHING;
