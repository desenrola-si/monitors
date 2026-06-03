-- ============================================================
-- 014_ai_rag_quality_alert_types.sql
-- ============================================================
-- Alerts emitidos pelo ai-rag-quality-monitor — vigia o workflow
-- sunomono-conversas-kb-pilot (e futuros workflows com knowledge_base
-- step) detectando regressões de qualidade do RAG.
--
-- Contexto: migração do sunomono do padrão "prompt monolítico" pro
-- padrão "knowledge_base + prompt enxuto". O monitor olha as
-- execuções recentes no DB do workflow-processor e classifica
-- amostras com problema em 3 categorias.

INSERT INTO alert_types (code, description) VALUES
  ('ai_rag_cot_leak',
   'IA vazou raciocínio interno (chain-of-thought) na resposta enviada ao cliente — risco P0 de exposição de fluxo interno')
ON CONFLICT (code) DO NOTHING;

INSERT INTO alert_types (code, description) VALUES
  ('ai_rag_zero_chunks',
   'Step knowledge_base completou sem recuperar nenhum chunk da KB — modelo respondeu sem contexto factual, risco de invenção')
ON CONFLICT (code) DO NOTHING;

INSERT INTO alert_types (code, description) VALUES
  ('ai_rag_early_human_escalation',
   'Workflow chamou request_human_intervention já no primeiro turno (sem conversationHistory) — IA escalando cedo demais sem tentar resolver via KB')
ON CONFLICT (code) DO NOTHING;
