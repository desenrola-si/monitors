import { injectable, inject } from 'inversify';
import { TYPES } from '../types.js';
import { Database } from '../database.js';

export type AlertTypeCode =
  | 'dm_not_delivered'
  | 'workflow_failure'
  | 'message_delivery_failure'
  | 'workflow_failure_burst'
  | 'wa_24h_window_closed'
  | 'ig_dm_silent_drop'
  | 'crm_automation_step_failed'
  | 'crm_automation_step_overdue'
  | 'reservation_duplicate'
  | 'reservation_outside_slot'
  | 'session_abandoned_midflow'
  | 'ig_inbound_no_response'
  | 'workflow_debounce_dlq'
  | 'anthrotech_scheduled_without_availability_check'
  | 'anthrotech_date_weekday_mismatch'
  | 'customer_duplicate_wa_id_drift'
  | 'multi_account_compliance_gap'
  | 'ai_rag_cot_leak'
  | 'ai_rag_zero_chunks'
  | 'ai_rag_early_human_escalation'
  | 'duplicate_outbound_burst';

export type AlertStatusCode =
  | 'open'
  | 'resolved_by_ai'
  | 'resolved_by_human'
  | 'resolved_auto'
  | 'expired';

export interface AlertRow {
  id: string;
  alertTypeCode: AlertTypeCode;
  tenantId: string | null;
  requestId: string | null;
  fingerprint: string;
  payload: Record<string, unknown>;
  statusCode: AlertStatusCode;
  notifiedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  resolutionEvidence: Record<string, unknown> | null;
}

interface InsertAlertArgs {
  typeCode: AlertTypeCode;
  tenantId?: string | null;
  requestId?: string | null;
  fingerprint: string;
  payload: Record<string, unknown>;
}

interface MarkResolvedArgs {
  byStatusCode:
    | 'resolved_by_ai'
    | 'resolved_by_human'
    | 'resolved_auto'
    | 'expired';
  note: string;
  evidence?: Record<string, unknown>;
}

/**
 * Repository pros alerts em `monitors`. Encapsula joins com lookup tables
 * pra que o caller use codes (strings) e não IDs.
 *
 * Concurrency: o INSERT usa ON CONFLICT (fingerprint) DO NOTHING + RETURNING
 * pra ser idempotente. Se dois ticks correm em paralelo (ex: cron + manual),
 * só um cria, o outro recebe rows=[] e descobre que já existe.
 */
@injectable()
export class AlertsRepository {
  constructor(@inject(TYPES.Database) private readonly db: Database) {}

  async findByFingerprint(fingerprint: string): Promise<AlertRow | null> {
    const rows = await this.db.query<AlertRowRaw>(
      `${SELECT_ALERT_BASE} WHERE a.fingerprint = $1 LIMIT 1`,
      [fingerprint],
      'monitors',
    );
    return rows[0] ? mapAlert(rows[0]) : null;
  }

  /**
   * Insere alert com status=open. Idempotente: se já existe (UNIQUE em
   * fingerprint), retorna null pra sinalizar "já existia, não notifique de novo".
   * Quando retorna AlertRow, é um INSERT novo → deve notificar Google Chat.
   */
  async insertOpen(args: InsertAlertArgs): Promise<AlertRow | null> {
    const rows = await this.db.query<{ id: string }>(
      `
      INSERT INTO alerts (
        alert_type_id, tenant_id, request_id, fingerprint, payload, status_id
      )
      VALUES (
        (SELECT id FROM alert_types WHERE code = $1),
        $2, $3, $4, $5::jsonb,
        (SELECT id FROM alert_statuses WHERE code = 'open')
      )
      ON CONFLICT (fingerprint) DO NOTHING
      RETURNING id
      `,
      [
        args.typeCode,
        args.tenantId ?? null,
        args.requestId ?? null,
        args.fingerprint,
        JSON.stringify(args.payload),
      ],
      'monitors',
    );
    if (rows.length === 0) return null;
    return this.findByFingerprint(args.fingerprint);
  }

  async listOpenByType(typeCode: AlertTypeCode): Promise<AlertRow[]> {
    const rows = await this.db.query<AlertRowRaw>(
      `${SELECT_ALERT_BASE}
       WHERE at.code = $1 AND s.code = 'open'
       ORDER BY a.notified_at ASC`,
      [typeCode],
      'monitors',
    );
    return rows.map(mapAlert);
  }

  async markResolved(id: string, args: MarkResolvedArgs): Promise<void> {
    await this.db.query(
      `
      UPDATE alerts
      SET status_id = (SELECT id FROM alert_statuses WHERE code = $2),
          resolved_at = NOW(),
          resolution_note = $3,
          resolution_evidence = $4::jsonb,
          updated_at = NOW()
      WHERE id = $1
      `,
      [
        id,
        args.byStatusCode,
        args.note,
        args.evidence ? JSON.stringify(args.evidence) : null,
      ],
      'monitors',
    );
  }
}

// — internals —

interface AlertRowRaw {
  id: string;
  alert_type_code: AlertTypeCode;
  tenant_id: string | null;
  request_id: string | null;
  fingerprint: string;
  payload: Record<string, unknown>;
  status_code: AlertStatusCode;
  notified_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  resolution_evidence: Record<string, unknown> | null;
}

const SELECT_ALERT_BASE = `
  SELECT
    a.id::text AS id,
    at.code AS alert_type_code,
    a.tenant_id::text AS tenant_id,
    a.request_id,
    a.fingerprint,
    a.payload,
    s.code AS status_code,
    TO_CHAR(a.notified_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS notified_at,
    TO_CHAR(a.resolved_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS resolved_at,
    a.resolution_note,
    a.resolution_evidence
  FROM alerts a
  JOIN alert_types at ON at.id = a.alert_type_id
  JOIN alert_statuses s ON s.id = a.status_id
`;

function mapAlert(r: AlertRowRaw): AlertRow {
  return {
    id: r.id,
    alertTypeCode: r.alert_type_code,
    tenantId: r.tenant_id,
    requestId: r.request_id,
    fingerprint: r.fingerprint,
    payload: r.payload,
    statusCode: r.status_code,
    notifiedAt: r.notified_at,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note,
    resolutionEvidence: r.resolution_evidence,
  };
}
