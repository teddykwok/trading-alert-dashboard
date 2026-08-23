import { Prisma } from "@prisma/client";
import type {
  ExecutionEventType,
  ExecutionOrderRole,
  ExecutionOrderSide,
  ExecutionOrderType,
  ExecutionPositionSide,
  PrismaClient,
  TradeExecution,
  TradeExecutionStatus,
} from "@prisma/client";
import {
  EXTREME_RR_LOOKBACKS,
  normalizeSourceTimeframe,
  type DynamicLeveragePlan,
} from "@trading-alert-dashboard/shared";
import { NotFoundError, ValidationError } from "../../utils/errors";
import {
  assertDecimalString,
  buildClientOrderId,
  sanitizeMetadata,
} from "./execution-safety";
import { canTransition, type TradeExecutionStatusName } from "./execution-status";

/**
 * Execution lifecycle service — DATABASE ONLY.
 *
 * Nothing here talks to Binance. It creates local rows, validates status
 * transitions, appends events and records actuals. There is deliberately no
 * submitOrder/cancelOrder/changeLeverage/changeMarginType/changePositionMode
 * method anywhere in this phase, and the module imports no HTTP client.
 *
 * Concurrency: every mutation is a conditional `updateMany` guarded by the
 * caller's expectedVersion inside a transaction. A zero-row update means
 * another writer won, and the whole transaction (including its event) rolls
 * back. `version` doubles as the event sequence number, so ordering is
 * strictly increasing and gap-free per execution.
 */

/** Raised when expectedVersion no longer matches the stored row. */
export class OptimisticLockError extends ValidationError {
  constructor(executionId: string, expectedVersion: number) {
    super(
      `Execution ${executionId} was modified concurrently (expectedVersion ${expectedVersion} is stale).`
    );
    this.name = "OptimisticLockError";
  }
}

export interface CreateExecutionInput {
  executionProfileId: string;
  alertId: string;
  extremeRRPlanId?: string | null;
  /** Phase 3 result — must be READY with a selected leverage. */
  plan: DynamicLeveragePlan;
  positionSide?: ExecutionPositionSide;
  takeProfit?: string | null;
  estimatedRewardRatio?: string | null;
  entryExpiresAt?: Date | null;
  /**
   * The persisted Extreme RR lookback this execution was planned from. Must
   * be one of 100/200/300 — supplied explicitly or carried by the candidate
   * snapshot's `requestedCandles`. There is no default: an unknown lookback
   * means the plan provenance is unknown, so creation is rejected.
   */
  selectedLookback?: number;
  /** Frozen sanitized snapshots (exact decimal strings, never raw payloads). */
  snapshots?: {
    extremeRRCandidate?: unknown;
    marginPlan?: unknown;
    riskTemplate?: unknown;
    exchangeFilters?: unknown;
  };
  /**
   * Test/admin escape hatch ONLY: allows a disabled profile. Normal callers
   * must enable the profile deliberately.
   */
  allowDisabledProfile?: boolean;
}

export interface TransitionInput {
  executionId: string;
  expectedVersion: number;
  targetStatus: TradeExecutionStatusName;
  eventType: ExecutionEventType;
  reasonCode?: string | null;
  message?: string | null;
  metadata?: unknown;
  /** Set when the new state needs a human. */
  requiresManualIntervention?: boolean;
}

export interface ReserveOrderInput {
  executionId: string;
  /**
   * Required: reserving an order appends an event, so it takes the same
   * optimistic lock as every other event-producing mutation. The bumped
   * version becomes the event's sequence number.
   */
  expectedVersion: number;
  role: ExecutionOrderRole;
  generation?: number;
  side: ExecutionOrderSide;
  positionSide: ExecutionPositionSide;
  orderType: ExecutionOrderType;
  originalQuantity: string;
  price?: string | null;
  stopPrice?: string | null;
  timeInForce?: string | null;
  reduceOnly?: boolean | null;
  closePosition?: boolean | null;
}

export interface RecordActualsInput {
  executionId: string;
  expectedVersion: number;
  submittedEntryPrice?: string;
  averageFillPrice?: string;
  filledQuantity?: string;
  actualLeverage?: number;
  actualIsolatedMargin?: string;
  reportedLiquidationPrice?: string;
  actualExitPrice?: string;
  realizedPnl?: string;
  exitReason?: string;
  entrySubmittedAt?: Date;
  firstFillAt?: Date;
  entryFilledAt?: Date;
  protectionPlacedAt?: Date;
  closedAt?: Date;
  lastReconciledAt?: Date;
  message?: string | null;
  metadata?: unknown;
}

/** Planned columns that lifecycle methods must never write after creation. */
export const IMMUTABLE_PLANNED_FIELDS = [
  "plannedEntryPrice",
  "calculatedStopLoss",
  "executableStopLoss",
  "takeProfit",
  "riskBudgetUsd",
  "quantityRaw",
  "plannedQuantity",
  "quantityStepSize",
  "actualPlannedLoss",
  "unusedRiskBudget",
  "positionNotional",
  "targetIsolatedMargin",
  "maximumIsolatedMargin",
  "selectedLeverage",
  "estimatedInitialMargin",
  "estimatedLiquidationPrice",
  "requiredLiquidationBoundary",
  "liquidationBufferRatio",
  "selectedLookback",
  "extremeRRCandidateSnapshot",
  "marginPlanSnapshot",
  "riskTemplateSnapshot",
  "exchangeFiltersSnapshot",
] as const;

export class ExecutionService {
  constructor(private readonly prisma: PrismaClient) {}

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  /**
   * Creates one execution from an explicitly supplied READY plan.
   *
   * Idempotent per (alert, profile): an identical retry returns the existing
   * row, while a retry whose frozen plan values differ is rejected rather
   * than silently rewriting history.
   */
  async createExecutionFromReadyPlan(input: CreateExecutionInput): Promise<TradeExecution> {
    const { plan } = input;

    if (plan.status !== "READY") {
      throw new ValidationError(
        `Only a READY margin plan can create an execution (got ${plan.status}${plan.reason ? `/${plan.reason}` : ""}).`
      );
    }
    if (plan.selectedLeverage === null) {
      throw new ValidationError("A READY plan must carry a selected leverage.");
    }
    for (const [field, value] of [
      ["roundedQuantity", plan.roundedQuantity],
      ["positionNotional", plan.positionNotional],
      ["estimatedInitialMargin", plan.estimatedInitialMargin],
      ["targetIsolatedMargin", plan.targetIsolatedMargin],
      ["maximumIsolatedMargin", plan.maximumIsolatedMargin],
      ["actualPlannedLoss", plan.actualPlannedLoss],
      ["quantityStepSize", plan.quantityStepSize],
    ] as const) {
      if (value === null) throw new ValidationError(`A READY plan must carry ${field}.`);
    }

    const selectedLookback = this.resolveSelectedLookback(input);

    const profile = await this.prisma.executionProfile.findUnique({
      where: { id: input.executionProfileId },
    });
    if (!profile) throw new NotFoundError(`Execution profile ${input.executionProfileId} not found.`);
    if (!profile.isEnabled && input.allowDisabledProfile !== true) {
      throw new ValidationError(
        `Execution profile ${profile.id} is disabled; enable it or pass the explicit admin override.`
      );
    }

    const planned = {
      symbol: plan.symbol,
      direction: plan.direction,
      positionSide: input.positionSide ?? (plan.direction as ExecutionPositionSide),
      selectedLookback: 0, // replaced below from the candidate/plan
      plannedEntryPrice: assertDecimalString(plan.entryPrice, "entryPrice", { allowZero: false }),
      calculatedStopLoss: assertDecimalString(plan.calculatedStopLoss, "calculatedStopLoss", { allowZero: false }),
      executableStopLoss: assertDecimalString(plan.stopLoss, "executableStopLoss", { allowZero: false }),
      riskBudgetUsd: assertDecimalString(plan.riskBudgetUsd, "riskBudgetUsd", { allowZero: false }),
      quantityRaw: assertDecimalString(plan.quantityRaw as string, "quantityRaw", { allowZero: false }),
      plannedQuantity: assertDecimalString(plan.roundedQuantity as string, "plannedQuantity", { allowZero: false }),
      quantityStepSize: assertDecimalString(plan.quantityStepSize as string, "quantityStepSize", { allowZero: false }),
      actualPlannedLoss: assertDecimalString(plan.actualPlannedLoss as string, "actualPlannedLoss"),
      unusedRiskBudget: assertDecimalString(plan.unusedRiskBudget ?? "0", "unusedRiskBudget"),
      positionNotional: assertDecimalString(plan.positionNotional as string, "positionNotional", { allowZero: false }),
      targetIsolatedMargin: assertDecimalString(plan.targetIsolatedMargin as string, "targetIsolatedMargin"),
      maximumIsolatedMargin: assertDecimalString(plan.maximumIsolatedMargin as string, "maximumIsolatedMargin"),
      selectedLeverage: plan.selectedLeverage,
      estimatedInitialMargin: assertDecimalString(plan.estimatedInitialMargin as string, "estimatedInitialMargin"),
      liquidationBufferRatio: assertDecimalString(plan.liquidationBufferRatio, "liquidationBufferRatio"),
    };
    planned.selectedLookback = 0;

    // The ORIGINAL signal time is frozen onto the execution at creation.
    // Admission freshness must never be measured from createdAt (which only
    // says when we got around to planning), and retention may later null
    // alertId — so the value has to live on the execution itself.
    const alert = await this.prisma.alert.findUnique({
      where: { id: input.alertId },
      select: { triggeredAt: true, sourceTimeframe: true },
    });
    if (!alert) throw new NotFoundError(`Alert ${input.alertId} not found.`);
    if (!(alert.triggeredAt instanceof Date) || Number.isNaN(alert.triggeredAt.getTime())) {
      throw new ValidationError(
        `Alert ${input.alertId} has no usable triggeredAt; refusing to create an execution with unknown signal time.`
      );
    }

    const existing = await this.prisma.tradeExecution.findUnique({
      where: { alertId_executionProfileId: { alertId: input.alertId, executionProfileId: profile.id } },
    });
    if (existing) {
      this.assertIdenticalPlan(existing, planned, plan);
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.tradeExecution.create({
        data: {
          executionProfileId: profile.id,
          alertId: input.alertId,
          extremeRRPlanId: input.extremeRRPlanId ?? null,
          symbol: planned.symbol,
          direction: planned.direction,
          positionSide: planned.positionSide,
          selectedLookback,
          signalTriggeredAt: alert.triggeredAt,
          // Frozen for the same reason as the line above: retention may null
          // alertId, and admission must not depend on a value that can vanish.
          // Re-normalized rather than copied verbatim so a row written by any
          // path is stored in the one canonical spelling admission compares
          // against; anything unrecognised is stored as null and fails closed.
          sourceTimeframe: normalizeSourceTimeframe(alert.sourceTimeframe),
          status: "PLAN_READY",
          version: 1,
          plannedEntryPrice: planned.plannedEntryPrice,
          calculatedStopLoss: planned.calculatedStopLoss,
          executableStopLoss: planned.executableStopLoss,
          takeProfit: input.takeProfit ? assertDecimalString(input.takeProfit, "takeProfit", { allowZero: false }) : null,
          riskBudgetUsd: planned.riskBudgetUsd,
          quantityRaw: planned.quantityRaw,
          plannedQuantity: planned.plannedQuantity,
          quantityStepSize: planned.quantityStepSize,
          actualPlannedLoss: planned.actualPlannedLoss,
          unusedRiskBudget: planned.unusedRiskBudget,
          positionNotional: planned.positionNotional,
          targetIsolatedMargin: planned.targetIsolatedMargin,
          maximumIsolatedMargin: planned.maximumIsolatedMargin,
          selectedLeverage: planned.selectedLeverage,
          estimatedInitialMargin: planned.estimatedInitialMargin,
          estimatedLiquidationPrice: plan.estimatedLiquidationPrice,
          requiredLiquidationBoundary: plan.requiredLiquidationBoundary,
          liquidationBufferRatio: planned.liquidationBufferRatio,
          estimatedRewardRatio: input.estimatedRewardRatio ?? null,
          entryExpiresAt: input.entryExpiresAt ?? null,
          extremeRRCandidateSnapshot: this.snapshot(input.snapshots?.extremeRRCandidate),
          marginPlanSnapshot: this.snapshot(input.snapshots?.marginPlan ?? plan),
          riskTemplateSnapshot: this.snapshot(input.snapshots?.riskTemplate),
          exchangeFiltersSnapshot: this.snapshot(input.snapshots?.exchangeFilters),
        },
      });

      await tx.executionEvent.create({
        data: {
          tradeExecutionId: created.id,
          sequenceNumber: created.version,
          eventType: "EXECUTION_CREATED",
          toStatus: "PLAN_READY",
          reasonCode: "PLAN_READY",
          message: `Execution created from a READY plan at ${plan.selectedLeverage}x.`,
          metadata: this.snapshot({
            symbol: plan.symbol,
            direction: plan.direction,
            selectedLeverage: plan.selectedLeverage,
          }),
        },
      });

      return created;
    });
  }

  /**
   * Resolves the frozen lookback, preferring the explicit input and falling
   * back to the candidate snapshot. Only the canonical Extreme RR lookbacks
   * are accepted — there is deliberately no default, so a missing or unknown
   * value fails creation rather than persisting a meaningless 0.
   */
  private resolveSelectedLookback(input: CreateExecutionInput): number {
    const fromSnapshot = (input.snapshots?.extremeRRCandidate as { requestedCandles?: unknown } | undefined)
      ?.requestedCandles;
    const candidate = input.selectedLookback ?? fromSnapshot;

    if (!(EXTREME_RR_LOOKBACKS as readonly number[]).includes(candidate as number)) {
      throw new ValidationError(
        `selectedLookback must be one of ${EXTREME_RR_LOOKBACKS.join(", ")} (got ${
          candidate === undefined ? "no value" : String(candidate)
        }).`
      );
    }
    return candidate as number;
  }

  /**
   * Rejects a retry whose frozen values differ from the stored execution.
   *
   * Decimal columns are compared NUMERICALLY, not as strings: Postgres
   * normalizes "1.50" to "1.5", so a textual comparison would wrongly reject
   * an identical retry.
   */
  private assertIdenticalPlan(
    existing: TradeExecution,
    planned: Record<string, unknown>,
    plan: DynamicLeveragePlan
  ): void {
    const mismatches: string[] = [];
    const compare = (field: string, stored: unknown, incoming: unknown) => {
      if (stored === null || stored === undefined || incoming === null || incoming === undefined) return;
      try {
        if (!new Prisma.Decimal(String(stored)).equals(new Prisma.Decimal(String(incoming)))) {
          mismatches.push(field);
        }
      } catch {
        if (String(stored) !== String(incoming)) mismatches.push(field);
      }
    };

    compare("plannedEntryPrice", existing.plannedEntryPrice, planned.plannedEntryPrice);
    compare("executableStopLoss", existing.executableStopLoss, planned.executableStopLoss);
    compare("plannedQuantity", existing.plannedQuantity, planned.plannedQuantity);
    compare("positionNotional", existing.positionNotional, planned.positionNotional);
    compare("riskBudgetUsd", existing.riskBudgetUsd, planned.riskBudgetUsd);
    if (existing.selectedLeverage !== plan.selectedLeverage) mismatches.push("selectedLeverage");
    if (existing.symbol !== plan.symbol) mismatches.push("symbol");

    if (mismatches.length > 0) {
      throw new ValidationError(
        `An execution already exists for this alert and profile with different frozen plan values (${mismatches.join(", ")}). Refusing to overwrite execution history.`
      );
    }
  }

  private snapshot(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) return undefined;
    return sanitizeMetadata(value) as Prisma.InputJsonValue;
  }

  // -------------------------------------------------------------------------
  // Status transitions
  // -------------------------------------------------------------------------

  /**
   * Validated, transactional, optimistically-locked status transition. The
   * status update and its event succeed or fail together.
   */
  async transition(input: TransitionInput): Promise<TradeExecution> {
    const execution = await this.prisma.tradeExecution.findUnique({ where: { id: input.executionId } });
    if (!execution) throw new NotFoundError(`Execution ${input.executionId} not found.`);

    const check = canTransition(
      execution.status as TradeExecutionStatusName,
      input.targetStatus
    );
    if (!check.allowed) throw new ValidationError(check.reason ?? "Transition not allowed.");

    const metadata = this.snapshot(input.metadata);

    return this.prisma.$transaction(async (tx) => {
      // Conditional update: only the writer holding the expected version wins.
      const updated = await tx.tradeExecution.updateMany({
        where: { id: input.executionId, version: input.expectedVersion },
        data: {
          status: input.targetStatus as TradeExecutionStatus,
          version: { increment: 1 },
          requiresManualIntervention:
            input.requiresManualIntervention ?? input.targetStatus === "MANUAL_INTERVENTION",
          decisionReasonCode: input.reasonCode ?? undefined,
          sanitizedMessage: input.message ?? undefined,
        },
      });
      if (updated.count === 0) {
        throw new OptimisticLockError(input.executionId, input.expectedVersion);
      }

      const next = await tx.tradeExecution.findUniqueOrThrow({ where: { id: input.executionId } });

      // version after increment is the next strictly increasing sequence.
      await tx.executionEvent.create({
        data: {
          tradeExecutionId: input.executionId,
          sequenceNumber: next.version,
          eventType: input.eventType,
          fromStatus: execution.status,
          toStatus: next.status,
          reasonCode: input.reasonCode ?? null,
          message: input.message ?? null,
          metadata,
        },
      });

      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Local order reservation (never touches Binance)
  // -------------------------------------------------------------------------

  /**
   * Reserves a LOCAL order row with a deterministic client order id. Sends
   * nothing to any exchange. An identical retry returns the existing row; a
   * conflicting retry for the same (execution, role, generation) is rejected.
   */
  async reserveOrder(input: ReserveOrderInput) {
    const generation = input.generation ?? 1;
    const execution = await this.prisma.tradeExecution.findUnique({ where: { id: input.executionId } });
    if (!execution) throw new NotFoundError(`Execution ${input.executionId} not found.`);

    const originalQuantity = assertDecimalString(input.originalQuantity, "originalQuantity", { allowZero: false });
    const price = input.price ? assertDecimalString(input.price, "price", { allowZero: false }) : null;
    const stopPrice = input.stopPrice ? assertDecimalString(input.stopPrice, "stopPrice", { allowZero: false }) : null;
    const clientOrderId = buildClientOrderId(execution.id, input.role, generation);

    const existing = await this.prisma.binanceOrder.findUnique({
      where: {
        tradeExecutionId_role_generation: {
          tradeExecutionId: execution.id,
          role: input.role,
          generation,
        },
      },
    });

    if (existing) {
      const conflicts: string[] = [];
      if (existing.side !== input.side) conflicts.push("side");
      if (existing.positionSide !== input.positionSide) conflicts.push("positionSide");
      if (existing.orderType !== input.orderType) conflicts.push("orderType");
      if (String(existing.originalQuantity) !== originalQuantity) conflicts.push("originalQuantity");
      if ((existing.price === null ? null : String(existing.price)) !== price) conflicts.push("price");
      if ((existing.stopPrice === null ? null : String(existing.stopPrice)) !== stopPrice) conflicts.push("stopPrice");

      if (conflicts.length > 0) {
        throw new ValidationError(
          `Order ${input.role} generation ${generation} is already reserved with different parameters (${conflicts.join(", ")}).`
        );
      }
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      // Same guard as every other event-producing mutation: a conditional
      // version bump. This both serializes concurrent reservations and yields
      // the event sequence number — no MAX(sequenceNumber)+1 read anywhere.
      const locked = await tx.tradeExecution.updateMany({
        where: { id: execution.id, version: input.expectedVersion },
        data: { version: { increment: 1 } },
      });
      if (locked.count === 0) {
        throw new OptimisticLockError(execution.id, input.expectedVersion);
      }
      const next = await tx.tradeExecution.findUniqueOrThrow({ where: { id: execution.id } });

      const order = await tx.binanceOrder.create({
        data: {
          tradeExecutionId: execution.id,
          role: input.role,
          generation,
          clientOrderId,
          side: input.side,
          positionSide: input.positionSide,
          orderType: input.orderType,
          timeInForce: input.timeInForce ?? null,
          price,
          stopPrice,
          originalQuantity,
          status: "PLANNED",
          reduceOnly: input.reduceOnly ?? null,
          closePosition: input.closePosition ?? null,
        },
      });

      await tx.executionEvent.create({
        data: {
          tradeExecutionId: execution.id,
          sequenceNumber: next.version,
          eventType: "ORDER_RESERVED",
          fromStatus: next.status,
          toStatus: next.status,
          reasonCode: input.role,
          message: `Reserved local ${input.role} order (generation ${generation}). No exchange call was made.`,
          metadata: this.snapshot({ clientOrderId, role: input.role, generation }),
        },
      });

      return order;
    });
  }

  // -------------------------------------------------------------------------
  // Actual values
  // -------------------------------------------------------------------------

  /**
   * Records actual/result values. Planned columns are never touched here.
   * Values are validated as decimal strings; a field may only be set, not
   * cleared (clearing requires an explicit future method).
   */
  async recordActuals(input: RecordActualsInput): Promise<TradeExecution> {
    const execution = await this.prisma.tradeExecution.findUnique({ where: { id: input.executionId } });
    if (!execution) throw new NotFoundError(`Execution ${input.executionId} not found.`);

    const data: Prisma.TradeExecutionUpdateInput = {};
    const changed: string[] = [];

    const decimalFields: Array<[keyof RecordActualsInput, string, DecimalRule]> = [
      ["submittedEntryPrice", "submittedEntryPrice", { allowZero: false }],
      ["averageFillPrice", "averageFillPrice", { allowZero: false }],
      ["filledQuantity", "filledQuantity", { allowZero: true }],
      ["actualIsolatedMargin", "actualIsolatedMargin", { allowZero: true }],
      ["reportedLiquidationPrice", "reportedLiquidationPrice", { allowZero: true }],
      ["actualExitPrice", "actualExitPrice", { allowZero: false }],
      // Realized PnL is the one value that may legitimately be negative.
      ["realizedPnl", "realizedPnl", { allowZero: true, allowNegative: true }],
    ];

    for (const [key, column, rule] of decimalFields) {
      const value = input[key];
      if (value === undefined) continue;
      (data as Record<string, unknown>)[column] = assertDecimalString(value, column, rule);
      changed.push(column);
    }

    if (input.actualLeverage !== undefined) {
      if (!Number.isSafeInteger(input.actualLeverage) || input.actualLeverage < 1) {
        throw new ValidationError("actualLeverage must be a positive integer.");
      }
      data.actualLeverage = input.actualLeverage;
      changed.push("actualLeverage");
    }
    if (input.exitReason !== undefined) {
      data.exitReason = input.exitReason;
      changed.push("exitReason");
    }

    for (const key of [
      "entrySubmittedAt",
      "firstFillAt",
      "entryFilledAt",
      "protectionPlacedAt",
      "closedAt",
      "lastReconciledAt",
    ] as const) {
      const value = input[key];
      if (value === undefined) continue;
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new ValidationError(`${key} must be a valid Date.`);
      }
      (data as Record<string, unknown>)[key] = value;
      changed.push(key);
    }

    if (changed.length === 0) throw new ValidationError("No actual values were supplied.");

    const metadata = this.snapshot({ ...(input.metadata as object | undefined), fields: changed });

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.tradeExecution.updateMany({
        where: { id: input.executionId, version: input.expectedVersion },
        data: { ...(data as Prisma.TradeExecutionUpdateManyMutationInput), version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new OptimisticLockError(input.executionId, input.expectedVersion);
      }

      const next = await tx.tradeExecution.findUniqueOrThrow({ where: { id: input.executionId } });

      await tx.executionEvent.create({
        data: {
          tradeExecutionId: input.executionId,
          sequenceNumber: next.version,
          eventType: "ACTUALS_UPDATED",
          fromStatus: execution.status,
          toStatus: next.status,
          message: input.message ?? `Recorded actual values: ${changed.join(", ")}.`,
          metadata,
        },
      });

      return next;
    });
  }

  async listEvents(executionId: string) {
    return this.prisma.executionEvent.findMany({
      where: { tradeExecutionId: executionId },
      orderBy: { sequenceNumber: "asc" },
    });
  }
}

interface DecimalRule {
  allowZero?: boolean;
  allowNegative?: boolean;
}
