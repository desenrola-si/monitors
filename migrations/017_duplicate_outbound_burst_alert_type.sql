-- ============================================================
-- 017_duplicate_outbound_burst_alert_type.sql
-- ============================================================
-- Alert type novo: a mesma mensagem de saída (origin 'tenant'/'template')
-- foi gravada várias vezes em poucos segundos para a mesma conversa/conta —
-- ou seja, foi enviada repetidamente pra Meta (wamids reais distintos).
--
-- Cenário (incidente Moovery — 15/06/2026):
-- - Chat reenviava a mesma mensagem ~9x em segundos (texto e mensagem rápida).
-- - Raiz: exceção pós-enfileiramento no SendMessageActionService
--   (setHumanTakeover/CreateCustomer lançando EntityNotFoundError) fazia o
--   envio já efetivado retornar erro → cliente reenviava → loop.
-- - Meta classificou como spam e bloqueou a conta (131031).
--
-- Pós-fix (PRs #674/#675): CreateCustomerService resiliente a corrida +
-- efeitos pós-enfileiramento best-effort. Este monitor garante o
-- comportamento — se aparecer alerta, há reenvio em rajada de novo.

INSERT INTO alert_types (code, description) VALUES
  ('duplicate_outbound_burst',
   'Mesma mensagem de saída (tenant/template) enviada várias vezes em poucos segundos para a mesma conversa/conta — risco de bloqueio da conta na Meta por spam')
ON CONFLICT (code) DO NOTHING;
