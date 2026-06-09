-- ============================================================
-- 016_anthrotech_date_bruteforce_alert_type.sql
-- ============================================================
-- Alert type novo: a IA tentou VÁRIAS datas de agendamento no mesmo
-- turno (create_anthrotech_reinspection / create_anthrotech_work_order
-- com datas distintas) e agendou uma que deu certo — à revelia do
-- cliente, que tinha pedido outra data.
--
-- Cenário (incidente Carolina OS39820B — 01/06/2026):
-- - Cliente confirma reinspeção para 05/06 (sexta).
-- - create para 05/06 → 400 (indisponível). availability deu 500.
-- - IA tenta 06/06 (sábado, 400), 08/06 (400), 09/06 (200 OK) sozinha.
-- - Confirma "agendada com sucesso 09/06" — data que a cliente não
--   escolheu, ainda com dia-da-semana errado ("segunda" sendo terça).
--
-- Pós-hotfix (09/06/2026): descrição da tool de reinspeção proíbe
-- auto-retry de datas (no 400 → informar cliente + oferecer
-- disponibilidade) + regra no system_prompt do amilgas-ipg. Esse monitor
-- garante o comportamento — se aparecer alerta, é regressão.

INSERT INTO alert_types (code, description) VALUES
  ('anthrotech_date_bruteforce',
   'IA tentou múltiplas datas no mesmo turno e agendou uma sem o cliente escolher (brute-force de datas)')
ON CONFLICT (code) DO NOTHING;
