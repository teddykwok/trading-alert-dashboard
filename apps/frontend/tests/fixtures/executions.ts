import type {
  ExecutionDetail,
  ExecutionListItem,
  ExecutionListResponse,
  ExecutionOrder,
  ExecutionTimelineEntry,
  ProtectionStateView,
  SafetyAdmissionView,
} from "../../src/api/executions.api";

/** Stored-record fixtures for the execution lifecycle. Every timestamp is distinct, so evidence can be traced. */

export const T = (minute: number) => new Date(Date.UTC(2026, 9, 10, 9, minute, 0, 0)).toISOString();

export function order(overrides: Partial<ExecutionOrder> & Pick<ExecutionOrder, "role">): ExecutionOrder {
  return {
    id: `order-${overrides.role}-${overrides.generation ?? 1}`,
    generation: 1,
    clientOrderId: "client-1",
    clientAlgoId: null,
    exchangeOrderId: null,
    exchangeAlgoId: null,
    actualOrderId: null,
    side: "BUY",
    positionSide: "LONG",
    orderType: "LIMIT",
    timeInForce: "GTC",
    price: "100",
    triggerPrice: null,
    workingType: null,
    priceProtect: null,
    originalQuantity: "1",
    executedQuantity: "0",
    averageFillPrice: null,
    status: "PLANNED",
    algoStatus: null,
    exchangeStatusRaw: null,
    submittedAt: null,
    submissionUnknownAt: null,
    entryOrderExpiresAt: null,
    cancelRequestedAt: null,
    cancelConfirmedAt: null,
    triggeredAt: null,
    lastExchangeUpdateAt: null,
    lastReconcileAt: null,
    ...overrides,
  };
}

export function admission(decision: string, minute: number, version = 1, reasonCode: string | null = null): SafetyAdmissionView {
  return {
    id: `admission-${version}`,
    evaluatedVersion: version,
    decision,
    reasonCode,
    message: null,
    signalAgeSeconds: 4,
    effectiveLimits: null,
    capacityBefore: null,
    capacityProjected: null,
    symbolStateSummary: null,
    reservedRiskUsd: null,
    reservedMarginUsd: null,
    evaluatedAt: T(minute),
    binanceSnapshotAt: null,
  };
}

export function protection(state: string, overrides: Partial<ProtectionStateView> = {}): ProtectionStateView {
  return {
    state,
    confirmedOpenQuantity: "1",
    protectedStopQuantity: "0",
    protectedTakeProfitQuantity: "0",
    stopCoverageGap: "0",
    takeProfitCoverageGap: "0",
    currentGeneration: 1,
    liquidationSafe: true,
    verifiedAt: null,
    reasonCode: null,
    sanitizedMessage: null,
    ...overrides,
  };
}

export function transition(sequenceNumber: number, toStatus: string, minute: number): ExecutionTimelineEntry {
  return { id: `event-${sequenceNumber}`, sequenceNumber, eventType: "STATUS_CHANGED", fromStatus: null, toStatus, reasonCode: null, message: null, metadata: null, createdAt: T(minute) };
}

/** A bare execution: a plan row and nothing else recorded. */
export function detail(overrides: Partial<ExecutionDetail> = {}): ExecutionDetail {
  return {
    id: "exec-1",
    alertId: "alert-1",
    symbol: "BTCUSDT",
    direction: "LONG",
    positionSide: "LONG",
    status: "PLAN_READY",
    version: 1,
    requiresManualIntervention: false,
    decisionReasonCode: null,
    sanitizedMessage: null,
    selectedLookback: 100,
    profile: { id: "profile-a", name: "Account A", environment: "MAINNET" },
    signalTriggeredAt: T(0),
    createdAt: T(1),
    updatedAt: T(1),
    entryExpiresAt: null,
    lastReconciledAt: null,
    planned: {
      entryPrice: "100",
      calculatedStopLoss: "96",
      executableStopLoss: "96",
      takeProfit: "108",
      riskBudgetUsd: "1.5",
      quantityRaw: "0.375",
      quantity: "0.375",
      quantityStepSize: "0.001",
      actualPlannedLoss: "1.5",
      unusedRiskBudget: "0",
      positionNotional: "37.5",
      targetIsolatedMargin: "3.75",
      maximumIsolatedMargin: "5",
      selectedLeverage: 10,
      estimatedInitialMargin: "3.75",
      estimatedLiquidationPrice: null,
      requiredLiquidationBoundary: null,
      liquidationBufferRatio: "0.5",
      estimatedRewardRatio: "2",
    },
    actual: {
      submittedEntryPrice: null,
      averageFillPrice: null,
      filledQuantity: null,
      actualLeverage: null,
      actualIsolatedMargin: null,
      reportedLiquidationPrice: null,
      actualExitPrice: null,
      realizedPnl: null,
      tradingFeesUsd: null,
      fundingPnlUsd: null,
      netPnlUsd: null,
      exitReason: null,
      entrySubmittedAt: null,
      firstFillAt: null,
      entryFilledAt: null,
      protectionPlacedAt: null,
      closedAt: null,
    },
    entryOrder: null,
    protection: null,
    protectionOrders: [],
    takeProfitExecution: null,
    emergencyCloseOrder: null,
    marginAdjustments: [],
    safetyAdmissions: [],
    criticalAlerts: [],
    ...overrides,
  };
}

/** A complete, protected long: every step has its own stored record. */
export function protectedExecution(): ExecutionDetail {
  const base = detail();
  return detail({
    status: "PROTECTED",
    lastReconciledAt: T(30),
    safetyAdmissions: [admission("PASS", 2)],
    actual: { ...base.actual, entrySubmittedAt: T(3), firstFillAt: T(4), entryFilledAt: T(5), averageFillPrice: "100", filledQuantity: "0.375" },
    entryOrder: order({ role: "ENTRY", status: "FILLED", submittedAt: T(3), executedQuantity: "0.375" }),
    protection: protection("PROTECTED", { protectedStopQuantity: "0.375", protectedTakeProfitQuantity: "0.375", verifiedAt: T(8) }),
    protectionOrders: [
      order({ role: "STOP_LOSS", status: "NEW", submittedAt: T(6), orderType: "STOP_MARKET", side: "SELL" }),
      order({ role: "TAKE_PROFIT", status: "NEW", submittedAt: T(7), orderType: "TAKE_PROFIT_MARKET", side: "SELL" }),
    ],
  });
}

export function listItem(overrides: Partial<ExecutionListItem> = {}): ExecutionListItem {
  return {
    id: "exec-1",
    alertId: "alert-1",
    alertSource: "TRADINGVIEW",
    symbol: "BTCUSDT",
    direction: "LONG",
    positionSide: "LONG",
    status: "PROTECTED",
    protectionState: "PROTECTED",
    requiresManualIntervention: false,
    profile: { id: "profile-a", name: "Account A", environment: "MAINNET" },
    signalTriggeredAt: T(0),
    createdAt: T(1),
    updatedAt: T(30),
    plannedEntryPrice: "100",
    averageFillPrice: "100",
    plannedQuantity: "0.375",
    filledQuantity: "0.375",
    selectedLeverage: 10,
    actualLeverage: 10,
    maximumIsolatedMargin: "5",
    actualIsolatedMargin: "3.75",
    exitReason: null,
    realizedPnl: null,
    decisionReasonCode: null,
    ...overrides,
  };
}

export function listResponse(items: ExecutionListItem[], overrides: Partial<ExecutionListResponse> = {}): ExecutionListResponse {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 25,
    hasMore: false,
    metrics: { activeCount: 1, pendingEntryCount: 0, protectedCount: 1, manualInterventionCount: 0, closedCount: 0, knownRealizedPnl: "0", closedWithKnownPnl: 0, closedWithUnknownPnl: 0 },
    profiles: [{ id: "profile-a", name: "Account A", environment: "MAINNET" }],
    ...overrides,
  };
}
