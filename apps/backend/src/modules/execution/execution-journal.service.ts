import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../utils/errors";
import { FORBIDDEN_METADATA_KEYS, sanitizeMetadata } from "./execution-safety";

/**
 * Phase 8 — READ-ONLY execution journal.
 *
 * Observability only. This module deliberately imports no Binance client (read
 * or mutation), no Telegram sender, no queue/worker and no webhook handler, so
 * a dashboard request can never reach an exchange or change execution state.
 * Every query is a read; nothing here writes.
 *
 * Values leave through explicit DTOs — Prisma rows are never returned directly,
 * decimals travel as exact strings (never JS floats), timestamps as ISO-8601,
 * and metadata is re-sanitized at the boundary even though it was already
 * sanitized on write.
 */

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

type DecimalLike = Prisma.Decimal | number | string | null | undefined;

/**
 * Exact decimal string, or null. Null is preserved — it means "unknown" and is
 * never collapsed to "0".
 */
function decimal(value: DecimalLike): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Recursive sanitization applied again at the DTO boundary.
 *
 * Stricter than the write-time sanitizer: that one REDACTS a credential-like
 * value but keeps the key, which is fine for an internal audit row. On the
 * way out to a browser the key is dropped entirely, so no response ever
 * carries even the shape of a credential.
 */
function safeMetadata(value: Prisma.JsonValue | null | undefined): unknown {
  if (value === null || value === undefined) return null;
  return dropForbiddenKeys(sanitizeMetadata(value));
}

function dropForbiddenKeys(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => dropForbiddenKeys(entry, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    if (FORBIDDEN_METADATA_KEYS.some((forbidden) => normalized.includes(forbidden.replace(/[^a-z]/g, "")))) {
      continue;
    }
    output[key] = dropForbiddenKeys(entry, depth + 1);
  }
  return output;
}

/**
 * Net PnL is only meaningful when EVERY component is known. A partial sum
 * would read as a real result while silently treating unknown fees or funding
 * as zero, so any missing component yields null.
 */
export function deriveNetPnl(
  realizedPnl: string | null,
  tradingFeesUsd: string | null,
  fundingPnlUsd: string | null
): string | null {
  if (realizedPnl === null || tradingFeesUsd === null || fundingPnlUsd === null) return null;
  try {
    return new Prisma.Decimal(realizedPnl).minus(tradingFeesUsd).plus(fundingPnlUsd).toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface ExecutionProfileSummaryDto {
  id: string;
  name: string;
  environment: string;
  // accountIdentifier is deliberately absent: the UI never needs it.
}

export interface ExecutionListItemDto {
  id: string;
  alertId: string | null;
  symbol: string;
  direction: string;
  positionSide: string;
  status: string;
  protectionState: string | null;
  requiresManualIntervention: boolean;
  profile: ExecutionProfileSummaryDto;
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

export interface ExecutionListResultDto {
  items: ExecutionListItemDto[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ExecutionSummaryMetricsDto {
  activeCount: number;
  pendingEntryCount: number;
  protectedCount: number;
  manualInterventionCount: number;
  closedCount: number;
  /** Sum of the realized PnL values that ARE known. Never a completeness claim. */
  knownRealizedPnl: string;
  closedWithKnownPnl: number;
  /** Closed executions whose realized PnL is unknown — stated, never assumed 0. */
  closedWithUnknownPnl: number;
}

export interface ExecutionTimelineEntryDto {
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

export interface ExecutionOrderDto {
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

export interface ProtectionStateDto {
  state: string;
  confirmedOpenQuantity: string;
  protectedStopQuantity: string;
  protectedTakeProfitQuantity: string;
  /** Positive when exposure exceeds verified stop coverage. */
  stopCoverageGap: string;
  takeProfitCoverageGap: string;
  currentGeneration: number;
  liquidationSafe: boolean | null;
  verifiedAt: string | null;
  reasonCode: string | null;
  sanitizedMessage: string | null;
}

export interface MarginAdjustmentDto {
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

export interface SafetyAdmissionDto {
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

export interface CriticalAlertDto {
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

export interface ExecutionDetailDto {
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
  profile: ExecutionProfileSummaryDto;
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
    /** Null unless realized PnL, fees AND funding are all known. */
    netPnlUsd: string | null;
    exitReason: string | null;
    entrySubmittedAt: string | null;
    firstFillAt: string | null;
    entryFilledAt: string | null;
    protectionPlacedAt: string | null;
    closedAt: string | null;
  };

  entryOrder: ExecutionOrderDto | null;
  protection: ProtectionStateDto | null;
  protectionOrders: ExecutionOrderDto[];
  emergencyCloseOrder: ExecutionOrderDto | null;
  marginAdjustments: MarginAdjustmentDto[];
  safetyAdmissions: SafetyAdmissionDto[];
  criticalAlerts: CriticalAlertDto[];
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface ExecutionListFilters {
  symbol?: string;
  direction?: "LONG" | "SHORT";
  status?: string[];
  protectionState?: string[];
  executionProfileId?: string;
  environment?: "MAINNET" | "TESTNET";
  createdFrom?: Date;
  createdTo?: Date;
  requiresManualIntervention?: boolean;
  /** "active" excludes terminal statuses; "closed" keeps only them. */
  lifecycle?: "active" | "closed";
  page?: number;
  pageSize?: number;
}

/** Terminal statuses, mirrored from the Phase 4 pure state machine. */
const CLOSED_STATUSES = [
  "ENTRY_EXPIRED",
  "CLOSED_TP",
  "CLOSED_SL",
  "CLOSED_EMERGENCY",
  "CANCELED",
  "SKIPPED",
  "FAILED",
] as const;

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export class ExecutionJournalService {
  constructor(private readonly prisma: PrismaClient) {}

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  /**
   * Paginated summaries. Deliberately never loads timelines, and pulls the
   * profile and protection state through `include` so the page costs a bounded
   * number of queries rather than one per row.
   */
  async listExecutions(filters: ExecutionListFilters = {}): Promise<ExecutionListResultDto> {
    const pageSize = Math.min(Math.max(filters.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(filters.page ?? 1, 1);
    const where = this.buildWhere(filters);

    const [total, rows] = await Promise.all([
      this.prisma.tradeExecution.count({ where }),
      this.prisma.tradeExecution.findMany({
        where,
        // Stable: updatedAt can tie, so id breaks the tie deterministically.
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { executionProfile: true, protectionState: true },
      }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        alertId: row.alertId,
        symbol: row.symbol,
        direction: row.direction,
        positionSide: row.positionSide,
        status: row.status,
        protectionState: row.protectionState?.state ?? null,
        requiresManualIntervention: row.requiresManualIntervention,
        profile: this.toProfile(row.executionProfile),
        signalTriggeredAt: iso(row.signalTriggeredAt),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        plannedEntryPrice: decimal(row.plannedEntryPrice)!,
        averageFillPrice: decimal(row.averageFillPrice),
        plannedQuantity: decimal(row.plannedQuantity)!,
        filledQuantity: decimal(row.filledQuantity),
        selectedLeverage: row.selectedLeverage,
        actualLeverage: row.actualLeverage,
        maximumIsolatedMargin: decimal(row.maximumIsolatedMargin)!,
        actualIsolatedMargin: decimal(row.actualIsolatedMargin),
        exitReason: row.exitReason,
        realizedPnl: decimal(row.realizedPnl),
        decisionReasonCode: row.decisionReasonCode,
      })),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  /**
   * Counts and a PARTIAL realized-PnL sum. The unknown count travels with the
   * sum so the UI can never present it as a complete net result.
   */
  async getExecutionSummaryMetrics(filters: ExecutionListFilters = {}): Promise<ExecutionSummaryMetricsDto> {
    const where = this.buildWhere({ ...filters, lifecycle: undefined });
    const rows = await this.prisma.tradeExecution.findMany({
      where,
      select: {
        status: true,
        realizedPnl: true,
        requiresManualIntervention: true,
        protectionState: { select: { state: true } },
      },
    });

    let knownRealizedPnl = new Prisma.Decimal(0);
    let closedWithKnownPnl = 0;
    let closedWithUnknownPnl = 0;
    let activeCount = 0;
    let pendingEntryCount = 0;
    let protectedCount = 0;
    let manualInterventionCount = 0;
    let closedCount = 0;

    for (const row of rows) {
      const closed = (CLOSED_STATUSES as readonly string[]).includes(row.status);
      if (closed) {
        closedCount += 1;
        if (row.realizedPnl === null) closedWithUnknownPnl += 1;
        else {
          closedWithKnownPnl += 1;
          knownRealizedPnl = knownRealizedPnl.plus(row.realizedPnl);
        }
      } else if (row.status !== "MANUAL_INTERVENTION") {
        activeCount += 1;
      }

      if (["PREFLIGHT", "ENTRY_SUBMITTING", "ENTRY_PENDING", "PARTIALLY_FILLED"].includes(row.status)) {
        pendingEntryCount += 1;
      }
      if (row.protectionState?.state === "PROTECTED") protectedCount += 1;
      if (row.status === "MANUAL_INTERVENTION" || row.requiresManualIntervention) manualInterventionCount += 1;
    }

    return {
      activeCount,
      pendingEntryCount,
      protectedCount,
      manualInterventionCount,
      closedCount,
      knownRealizedPnl: knownRealizedPnl.toString(),
      closedWithKnownPnl,
      closedWithUnknownPnl,
    };
  }

  // -------------------------------------------------------------------------
  // Detail
  // -------------------------------------------------------------------------

  /**
   * Full detail in one query. Works from the execution's own frozen data, so a
   * retention-nulled alertId does not break it.
   */
  async getExecutionDetail(executionId: string): Promise<ExecutionDetailDto> {
    const row = await this.prisma.tradeExecution.findUnique({
      where: { id: executionId },
      include: {
        executionProfile: true,
        protectionState: true,
        orders: { orderBy: [{ role: "asc" }, { generation: "asc" }] },
        marginAdjustments: { orderBy: { attempt: "asc" } },
        safetyAdmissions: { orderBy: { evaluatedVersion: "desc" } },
        criticalAlerts: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!row) throw new NotFoundError(`Execution ${executionId} not found.`);

    const realizedPnl = decimal(row.realizedPnl);
    const tradingFeesUsd = decimal(row.tradingFeesUsd);
    const fundingPnlUsd = decimal(row.fundingPnlUsd);

    const orders = row.orders;
    const entryOrder = orders.find((order) => order.role === "ENTRY") ?? null;
    const emergencyCloseOrder = orders.find((order) => order.role === "EMERGENCY_CLOSE") ?? null;
    const protectionOrders = orders.filter(
      (order) => order.role === "STOP_LOSS" || order.role === "TAKE_PROFIT"
    );

    return {
      id: row.id,
      alertId: row.alertId,
      symbol: row.symbol,
      direction: row.direction,
      positionSide: row.positionSide,
      status: row.status,
      version: row.version,
      requiresManualIntervention: row.requiresManualIntervention,
      decisionReasonCode: row.decisionReasonCode,
      sanitizedMessage: row.sanitizedMessage,
      selectedLookback: row.selectedLookback,
      profile: this.toProfile(row.executionProfile),
      signalTriggeredAt: iso(row.signalTriggeredAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      entryExpiresAt: iso(row.entryExpiresAt),
      lastReconciledAt: iso(row.lastReconciledAt),

      planned: {
        entryPrice: decimal(row.plannedEntryPrice)!,
        calculatedStopLoss: decimal(row.calculatedStopLoss)!,
        executableStopLoss: decimal(row.executableStopLoss)!,
        takeProfit: decimal(row.takeProfit),
        riskBudgetUsd: decimal(row.riskBudgetUsd)!,
        quantityRaw: decimal(row.quantityRaw)!,
        quantity: decimal(row.plannedQuantity)!,
        quantityStepSize: decimal(row.quantityStepSize)!,
        actualPlannedLoss: decimal(row.actualPlannedLoss)!,
        unusedRiskBudget: decimal(row.unusedRiskBudget)!,
        positionNotional: decimal(row.positionNotional)!,
        targetIsolatedMargin: decimal(row.targetIsolatedMargin)!,
        maximumIsolatedMargin: decimal(row.maximumIsolatedMargin)!,
        selectedLeverage: row.selectedLeverage,
        estimatedInitialMargin: decimal(row.estimatedInitialMargin)!,
        estimatedLiquidationPrice: decimal(row.estimatedLiquidationPrice),
        requiredLiquidationBoundary: decimal(row.requiredLiquidationBoundary),
        liquidationBufferRatio: decimal(row.liquidationBufferRatio)!,
        estimatedRewardRatio: decimal(row.estimatedRewardRatio),
      },

      actual: {
        submittedEntryPrice: decimal(row.submittedEntryPrice),
        averageFillPrice: decimal(row.averageFillPrice),
        filledQuantity: decimal(row.filledQuantity),
        actualLeverage: row.actualLeverage,
        actualIsolatedMargin: decimal(row.actualIsolatedMargin),
        reportedLiquidationPrice: decimal(row.reportedLiquidationPrice),
        actualExitPrice: decimal(row.actualExitPrice),
        realizedPnl,
        tradingFeesUsd,
        fundingPnlUsd,
        netPnlUsd: deriveNetPnl(realizedPnl, tradingFeesUsd, fundingPnlUsd),
        exitReason: row.exitReason,
        entrySubmittedAt: iso(row.entrySubmittedAt),
        firstFillAt: iso(row.firstFillAt),
        entryFilledAt: iso(row.entryFilledAt),
        protectionPlacedAt: iso(row.protectionPlacedAt),
        closedAt: iso(row.closedAt),
      },

      entryOrder: entryOrder ? this.toOrder(entryOrder) : null,
      protection: row.protectionState ? this.toProtection(row.protectionState) : null,
      protectionOrders: protectionOrders.map((order) => this.toOrder(order)),
      emergencyCloseOrder: emergencyCloseOrder ? this.toOrder(emergencyCloseOrder) : null,
      marginAdjustments: row.marginAdjustments.map((intent) => ({
        id: intent.id,
        attempt: intent.attempt,
        positionSide: intent.positionSide,
        amount: decimal(intent.amount)!,
        baselineIsolatedMargin: decimal(intent.baselineIsolatedMargin),
        verifiedIsolatedMargin: decimal(intent.verifiedIsolatedMargin),
        status: intent.status,
        reasonCode: intent.reasonCode,
        requestedAt: iso(intent.requestedAt),
        resolvedAt: iso(intent.resolvedAt),
        createdAt: intent.createdAt.toISOString(),
      })),
      safetyAdmissions: row.safetyAdmissions.map((admission) => ({
        id: admission.id,
        evaluatedVersion: admission.evaluatedVersion,
        decision: admission.decision,
        reasonCode: admission.reasonCode,
        message: admission.message,
        signalAgeSeconds: admission.signalAgeSeconds,
        effectiveLimits: safeMetadata(admission.effectiveLimits),
        capacityBefore: safeMetadata(admission.capacityBefore),
        capacityProjected: safeMetadata(admission.capacityProjected),
        symbolStateSummary: safeMetadata(admission.symbolStateSummary),
        reservedRiskUsd: decimal(admission.reservedRiskUsd),
        reservedMarginUsd: decimal(admission.reservedMarginUsd),
        evaluatedAt: admission.evaluatedAt.toISOString(),
        binanceSnapshotAt: iso(admission.binanceSnapshotAt),
      })),
      criticalAlerts: row.criticalAlerts.map((alert) => ({
        id: alert.id,
        alertType: alert.alertType,
        reasonCode: alert.reasonCode,
        message: alert.message,
        details: safeMetadata(alert.details),
        status: alert.status,
        attempts: alert.attempts,
        lastError: alert.lastError,
        createdAt: alert.createdAt.toISOString(),
        sentAt: iso(alert.sentAt),
        updatedAt: alert.updatedAt.toISOString(),
      })),
    };
  }

  /** The execution for one alert, or null. Never creates anything. */
  async getExecutionForAlert(alertId: string): Promise<ExecutionDetailDto | null> {
    const row = await this.prisma.tradeExecution.findFirst({
      where: { alertId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return row ? this.getExecutionDetail(row.id) : null;
  }

  /**
   * The full ordered event history.
   *
   * Ordered by sequenceNumber, which is the AUTHORITATIVE order: two events can
   * share a createdAt, and sorting by time alone would present them wrongly.
   */
  async getExecutionTimeline(executionId: string): Promise<ExecutionTimelineEntryDto[]> {
    const exists = await this.prisma.tradeExecution.findUnique({
      where: { id: executionId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundError(`Execution ${executionId} not found.`);

    const events = await this.prisma.executionEvent.findMany({
      where: { tradeExecutionId: executionId },
      orderBy: { sequenceNumber: "asc" },
    });

    return events.map((event) => ({
      id: event.id,
      sequenceNumber: event.sequenceNumber,
      eventType: event.eventType,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      reasonCode: event.reasonCode,
      message: event.message,
      metadata: safeMetadata(event.metadata),
      createdAt: event.createdAt.toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildWhere(filters: ExecutionListFilters): Prisma.TradeExecutionWhereInput {
    const where: Prisma.TradeExecutionWhereInput = {};

    if (filters.symbol) where.symbol = { equals: filters.symbol.trim().toUpperCase() };
    if (filters.direction) where.direction = filters.direction;
    if (filters.status?.length) where.status = { in: filters.status as never };
    if (filters.executionProfileId) where.executionProfileId = filters.executionProfileId;
    if (filters.environment) where.executionProfile = { environment: filters.environment };
    if (filters.requiresManualIntervention !== undefined) {
      where.requiresManualIntervention = filters.requiresManualIntervention;
    }
    if (filters.protectionState?.length) {
      where.protectionState = { state: { in: filters.protectionState as never } };
    }
    if (filters.createdFrom || filters.createdTo) {
      where.createdAt = {
        ...(filters.createdFrom ? { gte: filters.createdFrom } : {}),
        ...(filters.createdTo ? { lte: filters.createdTo } : {}),
      };
    }
    if (filters.lifecycle === "closed") {
      where.status = { in: CLOSED_STATUSES as never };
    } else if (filters.lifecycle === "active") {
      where.status = { notIn: CLOSED_STATUSES as never };
    }

    return where;
  }

  private toProfile(profile: { id: string; name: string; environment: string }): ExecutionProfileSummaryDto {
    // accountIdentifier is intentionally not copied.
    return { id: profile.id, name: profile.name, environment: profile.environment };
  }

  private toOrder(order: {
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
    price: Prisma.Decimal | null;
    triggerPrice: Prisma.Decimal | null;
    workingType: string | null;
    priceProtect: boolean | null;
    originalQuantity: Prisma.Decimal;
    executedQuantity: Prisma.Decimal;
    averageFillPrice: Prisma.Decimal | null;
    status: string;
    algoStatus: string | null;
    exchangeStatusRaw: string | null;
    submittedAt: Date | null;
    submissionUnknownAt: Date | null;
    entryOrderExpiresAt: Date | null;
    cancelRequestedAt: Date | null;
    cancelConfirmedAt: Date | null;
    triggeredAt: Date | null;
    lastExchangeUpdateAt: Date | null;
    lastReconcileAt: Date | null;
  }): ExecutionOrderDto {
    return {
      id: order.id,
      role: order.role,
      generation: order.generation,
      clientOrderId: order.clientOrderId,
      clientAlgoId: order.clientAlgoId,
      exchangeOrderId: order.exchangeOrderId,
      exchangeAlgoId: order.exchangeAlgoId,
      actualOrderId: order.actualOrderId,
      side: order.side,
      positionSide: order.positionSide,
      orderType: order.orderType,
      timeInForce: order.timeInForce,
      price: decimal(order.price),
      triggerPrice: decimal(order.triggerPrice),
      workingType: order.workingType,
      priceProtect: order.priceProtect,
      originalQuantity: decimal(order.originalQuantity)!,
      executedQuantity: decimal(order.executedQuantity)!,
      averageFillPrice: decimal(order.averageFillPrice),
      status: order.status,
      algoStatus: order.algoStatus,
      exchangeStatusRaw: order.exchangeStatusRaw,
      submittedAt: iso(order.submittedAt),
      submissionUnknownAt: iso(order.submissionUnknownAt),
      entryOrderExpiresAt: iso(order.entryOrderExpiresAt),
      cancelRequestedAt: iso(order.cancelRequestedAt),
      cancelConfirmedAt: iso(order.cancelConfirmedAt),
      triggeredAt: iso(order.triggeredAt),
      lastExchangeUpdateAt: iso(order.lastExchangeUpdateAt),
      lastReconcileAt: iso(order.lastReconcileAt),
    };
  }

  private toProtection(state: {
    state: string;
    confirmedOpenQuantity: Prisma.Decimal;
    protectedStopQuantity: Prisma.Decimal;
    protectedTakeProfitQuantity: Prisma.Decimal;
    currentGeneration: number;
    liquidationSafe: boolean | null;
    verifiedAt: Date | null;
    reasonCode: string | null;
    sanitizedMessage: string | null;
  }): ProtectionStateDto {
    const open = state.confirmedOpenQuantity;
    const stopGap = open.minus(state.protectedStopQuantity);
    const takeProfitGap = open.minus(state.protectedTakeProfitQuantity);

    return {
      state: state.state,
      confirmedOpenQuantity: open.toString(),
      protectedStopQuantity: state.protectedStopQuantity.toString(),
      protectedTakeProfitQuantity: state.protectedTakeProfitQuantity.toString(),
      stopCoverageGap: stopGap.greaterThan(0) ? stopGap.toString() : "0",
      takeProfitCoverageGap: takeProfitGap.greaterThan(0) ? takeProfitGap.toString() : "0",
      currentGeneration: state.currentGeneration,
      liquidationSafe: state.liquidationSafe,
      verifiedAt: iso(state.verifiedAt),
      reasonCode: state.reasonCode,
      sanitizedMessage: state.sanitizedMessage,
    };
  }
}
