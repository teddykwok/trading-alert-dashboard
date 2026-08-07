import { apiClient } from "./client";

/**
 * Phase 8 execution journal — READ ONLY.
 *
 * Every decimal travels as an exact string (or null for "unknown"), and every
 * timestamp as ISO-8601. There are deliberately no create/update/delete
 * methods: the journal observes persisted state and never changes it.
 */

export interface ExecutionProfileSummary {
  id: string;
  name: string;
  environment: string;
}

export interface ExecutionListItem {
  id: string;
  alertId: string | null;
  symbol: string;
  direction: string;
  positionSide: string;
  status: string;
  protectionState: string | null;
  requiresManualIntervention: boolean;
  profile: ExecutionProfileSummary;
  signalTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  plannedEntryPrice: string;
  averageFillPrice: string | null;
  plannedQuantity: string;
  filledQuantity: string | null;
  selectedLeverage: number;
  actualLeverage: number | null;
  maximumIsolatedMargin: string;
  actualIsolatedMargin: string | null;
  exitReason: string | null;
  realizedPnl: string | null;
  decisionReasonCode: string | null;
}

export interface ExecutionSummaryMetrics {
  activeCount: number;
  pendingEntryCount: number;
  protectedCount: number;
  manualInterventionCount: number;
  closedCount: number;
  knownRealizedPnl: string;
  closedWithKnownPnl: number;
  closedWithUnknownPnl: number;
}

export interface ExecutionListResponse {
  items: ExecutionListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  metrics: ExecutionSummaryMetrics;
}

export interface ExecutionOrder {
  id: string;
  role: string;
  generation: number;
  clientOrderId: string;
  clientAlgoId: string | null;
  exchangeOrderId: string | null;
  exchangeAlgoId: string | null;
  actualOrderId: string | null;
  side: string;
  positionSide: string;
  orderType: string;
  timeInForce: string | null;
  price: string | null;
  triggerPrice: string | null;
  workingType: string | null;
  priceProtect: boolean | null;
  originalQuantity: string;
  executedQuantity: string;
  averageFillPrice: string | null;
  status: string;
  algoStatus: string | null;
  exchangeStatusRaw: string | null;
  submittedAt: string | null;
  submissionUnknownAt: string | null;
  entryOrderExpiresAt: string | null;
  cancelRequestedAt: string | null;
  cancelConfirmedAt: string | null;
  triggeredAt: string | null;
  lastExchangeUpdateAt: string | null;
  lastReconcileAt: string | null;
}

export interface ProtectionStateView {
  state: string;
  confirmedOpenQuantity: string;
  protectedStopQuantity: string;
  protectedTakeProfitQuantity: string;
  stopCoverageGap: string;
  takeProfitCoverageGap: string;
  currentGeneration: number;
  liquidationSafe: boolean | null;
  verifiedAt: string | null;
  reasonCode: string | null;
  sanitizedMessage: string | null;
}

export interface MarginAdjustment {
  id: string;
  attempt: number;
  positionSide: string;
  amount: string;
  baselineIsolatedMargin: string | null;
  verifiedIsolatedMargin: string | null;
  status: string;
  reasonCode: string | null;
  requestedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface SafetyAdmissionView {
  id: string;
  evaluatedVersion: number;
  decision: string;
  reasonCode: string | null;
  message: string | null;
  signalAgeSeconds: number | null;
  effectiveLimits: unknown;
  capacityBefore: unknown;
  capacityProjected: unknown;
  symbolStateSummary: unknown;
  reservedRiskUsd: string | null;
  reservedMarginUsd: string | null;
  evaluatedAt: string;
  binanceSnapshotAt: string | null;
}

export interface CriticalAlertView {
  id: string;
  alertType: string;
  reasonCode: string;
  message: string;
  details: unknown;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  updatedAt: string;
}

export interface ExecutionDetail {
  id: string;
  alertId: string | null;
  symbol: string;
  direction: string;
  positionSide: string;
  status: string;
  version: number;
  requiresManualIntervention: boolean;
  decisionReasonCode: string | null;
  sanitizedMessage: string | null;
  selectedLookback: number;
  profile: ExecutionProfileSummary;
  signalTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  entryExpiresAt: string | null;
  lastReconciledAt: string | null;
  planned: {
    entryPrice: string;
    calculatedStopLoss: string;
    executableStopLoss: string;
    takeProfit: string | null;
    riskBudgetUsd: string;
    quantityRaw: string;
    quantity: string;
    quantityStepSize: string;
    actualPlannedLoss: string;
    unusedRiskBudget: string;
    positionNotional: string;
    targetIsolatedMargin: string;
    maximumIsolatedMargin: string;
    selectedLeverage: number;
    estimatedInitialMargin: string;
    estimatedLiquidationPrice: string | null;
    requiredLiquidationBoundary: string | null;
    liquidationBufferRatio: string;
    estimatedRewardRatio: string | null;
  };
  actual: {
    submittedEntryPrice: string | null;
    averageFillPrice: string | null;
    filledQuantity: string | null;
    actualLeverage: number | null;
    actualIsolatedMargin: string | null;
    reportedLiquidationPrice: string | null;
    actualExitPrice: string | null;
    realizedPnl: string | null;
    tradingFeesUsd: string | null;
    fundingPnlUsd: string | null;
    netPnlUsd: string | null;
    exitReason: string | null;
    entrySubmittedAt: string | null;
    firstFillAt: string | null;
    entryFilledAt: string | null;
    protectionPlacedAt: string | null;
    closedAt: string | null;
  };
  entryOrder: ExecutionOrder | null;
  protection: ProtectionStateView | null;
  protectionOrders: ExecutionOrder[];
  emergencyCloseOrder: ExecutionOrder | null;
  marginAdjustments: MarginAdjustment[];
  safetyAdmissions: SafetyAdmissionView[];
  criticalAlerts: CriticalAlertView[];
}

export interface ExecutionTimelineEntry {
  id: string;
  sequenceNumber: number;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  reasonCode: string | null;
  message: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface ExecutionListParams {
  symbol?: string;
  direction?: string;
  status?: string[];
  protectionState?: string[];
  executionProfileId?: string;
  environment?: string;
  createdFrom?: string;
  createdTo?: string;
  requiresManualIntervention?: boolean;
  lifecycle?: "active" | "closed";
  page?: number;
  pageSize?: number;
}

export function buildExecutionListQuery(params: ExecutionListParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) search.append(key, String(entry));
    } else {
      search.append(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export const executionsApi = {
  list: (params: ExecutionListParams = {}) =>
    apiClient.get<ExecutionListResponse>(`/api/executions${buildExecutionListQuery(params)}`),
  detail: (executionId: string) => apiClient.get<ExecutionDetail>(`/api/executions/${executionId}`),
  timeline: (executionId: string) =>
    apiClient.get<ExecutionTimelineEntry[]>(`/api/executions/${executionId}/timeline`),
  /** null when the alert has no execution — opening the tab creates nothing. */
  forAlert: (alertId: string) => apiClient.get<ExecutionDetail | null>(`/api/alerts/${alertId}/execution`),
};
