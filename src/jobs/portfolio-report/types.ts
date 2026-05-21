import { Database } from '../../lib/database.js';
import { Logger } from '../../lib/logger.js';
import {
  SignalStatus,
  OverallStatus,
} from '../../lib/repositories/portfolio-repository.js';

export interface PortfolioTenant {
  id: string;
  name: string | null;
  workflowSlug: string | null;
  isPlaceholder: boolean; // workflow_slug LIKE 'TODO%' OR NULL
}

export interface PortfolioWindow {
  reportDate: string;     // YYYY-MM-DD (dia do snapshot, = ontem em BRT)
  currentStart: Date;     // start do dia atual (UTC)
  currentEnd: Date;       // end exclusive
  baselineStart: Date;    // 7 dias antes do currentStart
  baselineEnd: Date;      // = currentStart
}

export interface DimensionContext {
  db: Database;
  log: Logger;
  tenant: PortfolioTenant;
  window: PortfolioWindow;
}

export interface DimensionResult {
  dimension: 'volume' | 'frustration' | 'conversion' | 'operations';
  currentValue: number | null;
  baselineValue: number | null;
  deltaPct: number | null;
  status: SignalStatus;
  narrative: string;
  rawData: Record<string, unknown>;
}

export interface Dimension {
  readonly code: 'volume' | 'frustration' | 'conversion' | 'operations';
  run(ctx: DimensionContext): Promise<DimensionResult>;
}

export type { SignalStatus, OverallStatus };
