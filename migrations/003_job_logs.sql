-- ============================================================
-- 003_job_logs.sql — logs persistidos por job
-- ============================================================
-- Cada log emitido pelo logger com `job` bound vira um row aqui.
-- Permite ao dashboard hidratar histórico de logs ao montar
-- (sem isso, refresh perde tudo que estava no buffer in-memory).

CREATE TABLE job_logs (
  id BIGSERIAL PRIMARY KEY,
  job_name VARCHAR(100) NOT NULL,
  -- FK opcional pra job_runs — útil pra agrupar logs por execução,
  -- mas não obrigatório (logs fora de run também valem)
  job_run_id BIGINT REFERENCES job_runs(id) ON DELETE CASCADE,
  level VARCHAR(10) NOT NULL,
  message TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_logs_job_name_created ON job_logs(job_name, created_at DESC);
CREATE INDEX idx_job_logs_job_run ON job_logs(job_run_id, created_at);
