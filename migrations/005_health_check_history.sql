-- ============================================================
-- 005_health_check_history.sql — snapshots do HealthCheckJob
-- ============================================================
-- Permite reconstruir histórico de saúde geral e por tenant,
-- além dos alerts pontuais (que têm lifecycle).

CREATE TABLE health_check_runs (
  id BIGSERIAL PRIMARY KEY,
  job_run_id BIGINT REFERENCES job_runs(id) ON DELETE SET NULL,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMP,
  duration_ms INT,
  total_tenants_checked INT NOT NULL DEFAULT 0,
  total_problems_found INT NOT NULL DEFAULT 0,
  -- counts por check_code, ex: {"message_delivery_failure": 2, "workflow_failure_burst": 0}
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_health_check_runs_started ON health_check_runs(started_at DESC);

CREATE TABLE health_check_findings (
  id BIGSERIAL PRIMARY KEY,
  health_check_run_id BIGINT NOT NULL REFERENCES health_check_runs(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  tenant_name VARCHAR(200),
  check_code VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL,         -- 'warning' | 'critical'
  metric_value INT,                       -- ex: 8 (count, latency_ms, etc — depende do check)
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_findings_run ON health_check_findings(health_check_run_id);
CREATE INDEX idx_findings_tenant_created ON health_check_findings(tenant_id, created_at DESC);
CREATE INDEX idx_findings_check_created ON health_check_findings(check_code, created_at DESC);
