-- ============================================================
-- 002_job_overrides.sql — overrides de schedule por job
-- ============================================================
-- Permite alterar o schedule de um job via UI sem fazer deploy.
-- Daemon lê esses overrides no boot e quando recebe trigger de reload
-- (após POST /api/jobs/:name/schedule). Schedule default fica hardcoded
-- na classe Job; override DB tem precedência se existir.

CREATE TABLE job_overrides (
  job_name VARCHAR(100) PRIMARY KEY,
  schedule_override VARCHAR(120) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_by VARCHAR(100)
);
