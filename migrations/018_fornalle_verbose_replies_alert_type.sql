-- ============================================================
-- 018_fornalle_verbose_replies_alert_type.sql
-- ============================================================
-- Alert type novo: o agente da Fornalle (Bartô) voltou a responder de forma
-- prolixa — mensagens longas e cheias de informação que o cliente não pediu.
--
-- Contexto (ClickUp 86e20kakk — 24/06/2026):
-- - Reclamação: "IA está dando respostas longas pra perguntas simples".
-- - Ex.: cliente pergunta "hoje abre pra rodízio na Freguesia?" (sim/não) e o
--   agente responde preço + horário + meia-entrada + oferta de reserva + CTA.
-- - Fix: inserido "PRINCÍPIO 0 — CONCISÃO" no system_prompt do workflow
--   fornalle-validation-wf + teto de 1000 → 350 caracteres.
--
-- Baseline medido (respostas "simples", excluindo resumos de reserva):
-- - Pré-fix:  média 280 chars, 29% acima de 350.
-- - Pós-fix:  média 228 chars, 11% acima de 350.
--
-- Este monitor é um detector de REGRESSÃO: se a fatia de respostas simples
-- acima de 350 chars voltar aos níveis pré-fix, alerta — sinal de que o prompt
-- regrediu (sobrescrito por deploy/edição) ou que o modelo voltou a ser prolixo.

INSERT INTO alert_types (code, description) VALUES
  ('fornalle_verbose_replies',
   'Agente da Fornalle (Bartô) voltou a dar respostas prolixas a perguntas simples — fatia de respostas acima do teto de caracteres regrediu aos níveis pré-fix de concisão (ClickUp 86e20kakk)')
ON CONFLICT (code) DO NOTHING;
