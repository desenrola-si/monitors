-- ============================================================
-- 018_ai_response_cot_leak_alert_type.sql
-- ============================================================
-- Alert type novo: a IA vazou raciocínio interno (chain-of-thought) na
-- resposta ao cliente, ou respondeu em idioma que não é português.
--
-- Contexto (reincidência 16/07/2026, reportada pela Lays — Moovery/Bruum):
-- o modelo (deepseek) escreve o "pensamento" dentro da própria resposta
-- final, e esse raciocínio costuma sair em inglês. Mesmo padrão do
-- incidente Sunomono (03/06/2026).
--
-- Fix aplicado no workflow-processor (PR#117): enforceOutputPolicy injeta
-- guard anti-CoT + regra pt-BR no system prompt de toda resposta ao
-- cliente. Guard por prompt reduz muito mas não é 100% — este monitor
-- mede o comportamento residual em produção e alerta se voltar.

INSERT INTO alert_types (code, description) VALUES
  ('ai_response_cot_leak',
   'IA vazou raciocínio interno (chain-of-thought) na resposta ao cliente, ou respondeu em idioma que não é português — regressão do guard anti-CoT/idioma (PR#117 workflow-processor)')
ON CONFLICT (code) DO NOTHING;
