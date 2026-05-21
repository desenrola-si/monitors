-- ============================================================
-- 001_init.sql — schema inicial do banco `monitors`
-- ============================================================
-- Lookup tables seguem o padrão Desenrola: tabela com (id, code)
-- e FK integer em vez de varchar/enum.

-- Lookup: tipos de alerta. Generaliza pra outros monitors (não só frustração)
CREATE TABLE alert_types (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,
  description TEXT
);

INSERT INTO alert_types (code, description) VALUES
  ('frustration_not_escalated', 'Cliente sinalizou frustração/contestação e a IA não escalou pra humano'),
  ('dm_not_delivered',          'Mensagem Instagram DM marcada como enviada mas não foi entregue'),
  ('workflow_failure',          'Execução de workflow falhou silenciosamente');

-- Lookup: status do ciclo de vida de um alert
CREATE TABLE alert_statuses (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL
);

INSERT INTO alert_statuses (code) VALUES
  ('open'),
  ('resolved_by_ai'),
  ('resolved_by_human'),
  ('expired');

-- Tabela principal: alerts disparados pelos monitors
CREATE TABLE alerts (
  id BIGSERIAL PRIMARY KEY,
  alert_type_id BIGINT NOT NULL REFERENCES alert_types(id),
  tenant_id UUID,
  request_id VARCHAR(80),
  -- fingerprint dedup: type:tenant:request:first_signal. Evita criar 2x o
  -- mesmo alert (ex: tick a cada 5min do frustration-monitor reprocessa
  -- janela de 24h, mesmo sinal aparece de novo).
  fingerprint VARCHAR(255) UNIQUE NOT NULL,
  payload JSONB NOT NULL,
  status_id BIGINT NOT NULL REFERENCES alert_statuses(id),
  notified_at TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMP,
  resolution_note TEXT,
  -- ex: { "by": "ai", "ack_message": "Ok", "ack_ts": "..." }
  resolution_evidence JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_status_type ON alerts(status_id, alert_type_id);
CREATE INDEX idx_alerts_tenant_request ON alerts(tenant_id, request_id);
CREATE INDEX idx_alerts_notified_at ON alerts(notified_at DESC);

-- ============================================================
-- Histórico de execução dos jobs do daemon
-- ============================================================

CREATE TABLE job_run_statuses (
  id BIGSERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL
);

INSERT INTO job_run_statuses (code) VALUES
  ('running'),
  ('success'),
  ('failed');

CREATE TABLE job_runs (
  id BIGSERIAL PRIMARY KEY,
  job_name VARCHAR(100) NOT NULL,
  status_id BIGINT NOT NULL REFERENCES job_run_statuses(id),
  -- 'cron' = schedule disparou, 'manual' = trigger via dashboard
  trigger_source VARCHAR(20) NOT NULL,
  started_at TIMESTAMP NOT NULL,
  finished_at TIMESTAMP,
  duration_ms INT,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_runs_name_started ON job_runs(job_name, started_at DESC);
CREATE INDEX idx_job_runs_status ON job_runs(status_id);
