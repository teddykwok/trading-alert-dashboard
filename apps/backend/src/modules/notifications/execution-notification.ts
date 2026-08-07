import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

/**
 * Phase 9 — pure milestone derivation for execution Telegram notifications.
 *
 * No Prisma client, no network, no Telegram, no clock: this module turns an
 * already-read snapshot of DURABLY PERSISTED state into the set of milestones
 * that state has earned, plus a deterministic dedupe key for each one.
 *
 * Two rules drive everything here:
 *
 *  1. A milestone is derived from what the database can PROVE, never from an
 *     optimistic local assumption. An entry order that was POSTed but never
 *     reconciled has not been placed as far as this module is concerned.
 *  2. Derivation is idempotent. Running it a hundred times against unchanged
 *     state yields a hundred identical dedupe keys, and the unique constraint
 *     collapses them into one row.
 *
 * Nothing in this file can mutate an execution, submit an order or reach an
 * exchange.
 */

const D = Prisma.Decimal;
type DecimalValue = InstanceType<typeof Prisma.Decimal>;

export const EXECUTION_NOTIFICATION_TYPES = [
  "LIMIT_PLACED",
  "PARTIAL_FILL",
  "POSITION_FILLED",
  "POSITION_PROTECTED",
  "ENTRY_EXPIRED",
  "CLOSED_TP",
  "CLOSED_SL",
  "CLOSED_EMERGENCY",
  "TRADE_SKIPPED",
] as const;

export type ExecutionNotificationTypeName = (typeof EXECUTION_NOTIFICATION_TYPES)[number];

/** CRITICAL_PROTECTION_FAILURE is not in the list above on purpose: it has no
 *  ExecutionNotification row. Phase 7's CriticalAlert is the one authoritative
 *  durable record and is delivered through the same dispatcher. */
export const CRITICAL_NOTIFICATION_TYPE = "CRITICAL_PROTECTION_FAILURE";

/**
 * Causal delivery order inside one materialization batch.
 *
 * After a restart several previously-unsent milestones can materialize at the
 * same instant, so createdAt alone cannot order them. These weights guarantee
 * the chain a reader expects — an entry is placed before it fills, a position
 * fills before it closes — and in particular that CLOSED_TP is never delivered
 * before POSITION_FILLED.
 *
 * Within a type (several PARTIAL_FILL rows, several POSITION_PROTECTED rows)
 * the incremental quantity breaks the tie; see milestoneSequence below.
 */
const MILESTONE_ORDER: Record<ExecutionNotificationTypeName, number> = {
  TRADE_SKIPPED: 100,
  LIMIT_PLACED: 200,
  PARTIAL_FILL: 300,
  POSITION_FILLED: 400,
  POSITION_PROTECTED: 500,
  ENTRY_EXPIRED: 600,
  CLOSED_TP: 700,
  CLOSED_SL: 700,
  CLOSED_EMERGENCY: 700,
};

// ---------------------------------------------------------------------------
// Snapshot input — persisted state only
// ---------------------------------------------------------------------------

export interface EntryOrderSnapshot {
  status: string;
  executedQuantity: string;
  averageFillPrice: string | null;
  /**
   * True only once reconciliation has actually read the order back from the
   * exchange. A bare submission ACK never sets this, which is what stops
   * LIMIT_PLACED from firing on an unconfirmed POST.
   */
  reconciled: boolean;
}

export interface ProtectionSnapshot {
  state: string;
  confirmedOpenQuantity: string;
  protectedStopQuantity: string;
  protectedTakeProfitQuantity: string;
  /** null means "not established" and never means safe. */
  liquidationSafe: boolean | null;
  stopTriggerPrice: string | null;
  takeProfitTriggerPrice: string | null;
}

export interface ExecutionNotificationSnapshot {
  executionId: string;
  status: string;
  symbol: string;
  direction: string;
  plannedEntryPrice: string;
  plannedQuantity: string;
  selectedLeverage: number;
  riskBudgetUsd: string;
  executableStopLoss: string;
  takeProfit: string | null;
  averageFillPrice: string | null;
  actualExitPrice: string | null;
  realizedPnl: string | null;
  tradingFeesUsd: string | null;
  fundingPnlUsd: string | null;
  exitReason: string | null;
  decisionReasonCode: string | null;
  sanitizedMessage: string | null;
  entryOrder: EntryOrderSnapshot | null;
  protection: ProtectionSnapshot | null;
}

// ---------------------------------------------------------------------------
// Payloads — exact decimal strings or null, never a float, never zero-for-null
// ---------------------------------------------------------------------------

export interface NotificationPayload {
  type: ExecutionNotificationTypeName;
  symbol: string;
  direction: string;
  /** Populated per type; every value is an exact decimal string or null. */
  plannedEntryPrice?: string;
  plannedQuantity?: string;
  selectedLeverage?: number;
  riskBudgetUsd?: string;
  filledQuantity?: string;
  averageFillPrice?: string | null;
  protectedQuantity?: string;
  stopPrice?: string | null;
  takeProfitPrice?: string | null;
  exitPrice?: string | null;
  realizedPnl?: string | null;
  tradingFeesUsd?: string | null;
  fundingPnlUsd?: string | null;
  netPnlUsd?: string | null;
  reasonCode?: string | null;
  explanation?: string | null;
}

export interface DerivedMilestone {
  type: ExecutionNotificationTypeName;
  dedupeKey: string;
  severity: "INFO" | "WARNING";
  milestoneSequence: number;
  payload: NotificationPayload;
}

// ---------------------------------------------------------------------------
// Decimal helpers (exact — nothing here goes through a JS float)
// ---------------------------------------------------------------------------

function toDecimal(value: string | null | undefined): DecimalValue | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = new D(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Canonical form of a quantity for use inside a dedupe key. "0.10", "0.1" and
 * "0.100" describe the same fill and must not produce three notifications.
 */
export function canonicalQuantity(value: string): string {
  const parsed = toDecimal(value);
  return parsed === null ? value.trim() : parsed.toFixed();
}

/**
 * netPnl = realized - fees + funding, and ONLY when all three are known.
 * A null component makes the net result null — a missing fee is not a zero fee,
 * and reporting one as the other would misstate a real trade result.
 */
export function deriveNetPnl(
  realizedPnl: string | null,
  tradingFeesUsd: string | null,
  fundingPnlUsd: string | null
): string | null {
  const realized = toDecimal(realizedPnl);
  const fees = toDecimal(tradingFeesUsd);
  const funding = toDecimal(fundingPnlUsd);
  if (realized === null || fees === null || funding === null) return null;
  return realized.minus(fees).plus(funding).toFixed();
}

// ---------------------------------------------------------------------------
// Dedupe keys
// ---------------------------------------------------------------------------

/**
 * Deterministic key for one milestone. Never derived from a timestamp, a row
 * id or anything else that changes between runs, so a repeated materialization
 * of unchanged state produces a byte-identical key and the unique index
 * collapses concurrent writers onto a single row.
 *
 * The discriminator is what makes a genuinely NEW milestone distinct: a larger
 * cumulative fill, or a larger verified protected quantity.
 */
export function buildNotificationDedupeKey(
  executionId: string,
  type: ExecutionNotificationTypeName,
  discriminator = ""
): string {
  return createHash("sha256").update(`${executionId}|${type}|${discriminator}`).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Milestone predicates
// ---------------------------------------------------------------------------

/** Exchange states in which an ENTRY order is documented as accepted. */
const ACCEPTED_ENTRY_ORDER_STATUSES = ["NEW", "PARTIALLY_FILLED", "FILLED"];

/**
 * True when the entry order is proven to have reached the book: reconciliation
 * has read it back AND it is in an accepted state. A submission whose result is
 * still unknown, or a rejected order, fails this test.
 */
function entryIsConfirmedPlaced(snapshot: ExecutionNotificationSnapshot): boolean {
  const order = snapshot.entryOrder;
  if (!order || !order.reconciled) return false;
  if (!ACCEPTED_ENTRY_ORDER_STATUSES.includes(order.status)) return false;
  // ENTRY_SUBMITTING means the execution itself has not accepted the result yet.
  return snapshot.status !== "ENTRY_SUBMITTING";
}

/**
 * Zero live exposure, proven rather than assumed. Without a protection state
 * row a partially-filled entry cannot be shown to be flat, so it stays silent
 * instead of announcing an expiry that left a position open.
 */
function hasNoLiveExposure(snapshot: ExecutionNotificationSnapshot): boolean {
  const protection = snapshot.protection;
  if (protection) {
    const open = toDecimal(protection.confirmedOpenQuantity);
    return open !== null && open.isZero();
  }
  const filled = toDecimal(snapshot.entryOrder?.executedQuantity ?? "0");
  return filled !== null && filled.isZero();
}

/**
 * Full verified coverage of the CURRENT confirmed exposure. Every condition is
 * read from the persisted protection state, so an execution whose status says
 * PROTECTED while its protection row disagrees produces nothing.
 */
function protectionIsFullyVerified(protection: ProtectionSnapshot | null): DecimalValue | null {
  if (!protection) return null;
  if (protection.state !== "PROTECTED") return null;
  if (protection.liquidationSafe !== true) return null;

  const open = toDecimal(protection.confirmedOpenQuantity);
  const stop = toDecimal(protection.protectedStopQuantity);
  const takeProfit = toDecimal(protection.protectedTakeProfitQuantity);
  if (open === null || stop === null || takeProfit === null) return null;
  if (open.lessThanOrEqualTo(0)) return null;
  if (!stop.equals(open) || !takeProfit.equals(open)) return null;

  return open;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function base(snapshot: ExecutionNotificationSnapshot, type: ExecutionNotificationTypeName): NotificationPayload {
  return { type, symbol: snapshot.symbol, direction: snapshot.direction };
}

function closurePayload(
  snapshot: ExecutionNotificationSnapshot,
  type: ExecutionNotificationTypeName
): NotificationPayload {
  return {
    ...base(snapshot, type),
    exitPrice: snapshot.actualExitPrice,
    realizedPnl: snapshot.realizedPnl,
    tradingFeesUsd: snapshot.tradingFeesUsd,
    fundingPnlUsd: snapshot.fundingPnlUsd,
    netPnlUsd: deriveNetPnl(snapshot.realizedPnl, snapshot.tradingFeesUsd, snapshot.fundingPnlUsd),
  };
}

/**
 * Every milestone the persisted state currently earns, in causal order.
 *
 * This is a pure projection of state, not a diff against what was sent before:
 * the caller writes the rows and the unique dedupe index decides which of them
 * are new. That is what makes a restart safe — an execution that ran its whole
 * life while the process was down still yields its full milestone history.
 */
export function deriveEarnedMilestones(snapshot: ExecutionNotificationSnapshot): DerivedMilestone[] {
  const milestones: DerivedMilestone[] = [];

  const push = (
    type: ExecutionNotificationTypeName,
    payload: NotificationPayload,
    options: { discriminator?: string; severity?: "INFO" | "WARNING"; sequenceOffset?: number } = {}
  ): void => {
    milestones.push({
      type,
      dedupeKey: buildNotificationDedupeKey(snapshot.executionId, type, options.discriminator ?? ""),
      severity: options.severity ?? "INFO",
      milestoneSequence: MILESTONE_ORDER[type] + (options.sequenceOffset ?? 0),
      payload,
    });
  };

  // --- TRADE_SKIPPED ------------------------------------------------------
  // Terminal SKIPPED only. A retryable UNAVAILABLE or capacity conflict never
  // reaches this status, so it can never be announced as a skip.
  if (snapshot.status === "SKIPPED") {
    push(
      "TRADE_SKIPPED",
      {
        ...base(snapshot, "TRADE_SKIPPED"),
        reasonCode: snapshot.decisionReasonCode,
        explanation: snapshot.sanitizedMessage,
      },
      { severity: "WARNING" }
    );
  }

  const confirmedPlaced = entryIsConfirmedPlaced(snapshot);
  const filled = toDecimal(snapshot.entryOrder?.executedQuantity ?? null);
  const planned = toDecimal(snapshot.plannedQuantity);

  // --- LIMIT_PLACED -------------------------------------------------------
  if (confirmedPlaced) {
    push("LIMIT_PLACED", {
      ...base(snapshot, "LIMIT_PLACED"),
      plannedEntryPrice: snapshot.plannedEntryPrice,
      plannedQuantity: snapshot.plannedQuantity,
      selectedLeverage: snapshot.selectedLeverage,
      riskBudgetUsd: snapshot.riskBudgetUsd,
    });
  }

  // --- PARTIAL_FILL -------------------------------------------------------
  // Strictly between nothing and everything. A cumulative quantity that equals
  // the planned quantity is a completed fill, so the final tranche is announced
  // once as POSITION_FILLED rather than twice.
  if (confirmedPlaced && filled !== null && planned !== null && filled.greaterThan(0) && filled.lessThan(planned)) {
    const quantity = filled.toFixed();
    push(
      "PARTIAL_FILL",
      {
        ...base(snapshot, "PARTIAL_FILL"),
        filledQuantity: quantity,
        plannedQuantity: snapshot.plannedQuantity,
        averageFillPrice: snapshot.entryOrder?.averageFillPrice ?? snapshot.averageFillPrice ?? null,
      },
      { discriminator: canonicalQuantity(quantity) }
    );
  }

  // --- POSITION_FILLED ----------------------------------------------------
  if (confirmedPlaced && snapshot.entryOrder?.status === "FILLED" && filled !== null && filled.greaterThan(0)) {
    push("POSITION_FILLED", {
      ...base(snapshot, "POSITION_FILLED"),
      filledQuantity: filled.toFixed(),
      plannedQuantity: snapshot.plannedQuantity,
      averageFillPrice: snapshot.entryOrder?.averageFillPrice ?? snapshot.averageFillPrice ?? null,
    });
  }

  // --- POSITION_PROTECTED -------------------------------------------------
  // Keyed on the verified protected quantity, so re-verifying the SAME coverage
  // is silent while a later tranche that protects a larger exposure is a real,
  // separate milestone.
  const protectedQuantity = protectionIsFullyVerified(snapshot.protection);
  if (protectedQuantity !== null) {
    const quantity = protectedQuantity.toFixed();
    push(
      "POSITION_PROTECTED",
      {
        ...base(snapshot, "POSITION_PROTECTED"),
        protectedQuantity: quantity,
        stopPrice: snapshot.protection?.stopTriggerPrice ?? null,
        takeProfitPrice: snapshot.protection?.takeProfitTriggerPrice ?? null,
      },
      { discriminator: canonicalQuantity(quantity) }
    );
  }

  // --- ENTRY_EXPIRED ------------------------------------------------------
  if (snapshot.status === "ENTRY_EXPIRED" && hasNoLiveExposure(snapshot)) {
    push("ENTRY_EXPIRED", base(snapshot, "ENTRY_EXPIRED"));
  }

  // --- Closures -----------------------------------------------------------
  // The terminal status is the only trigger. Phase 7 has already proven the
  // position is flat, the entry remainder is neutralized and sibling cleanup
  // finished before writing it.
  if (snapshot.status === "CLOSED_TP") push("CLOSED_TP", closurePayload(snapshot, "CLOSED_TP"));
  if (snapshot.status === "CLOSED_SL") {
    push("CLOSED_SL", closurePayload(snapshot, "CLOSED_SL"), { severity: "WARNING" });
  }
  if (snapshot.status === "CLOSED_EMERGENCY") {
    push("CLOSED_EMERGENCY", closurePayload(snapshot, "CLOSED_EMERGENCY"), { severity: "WARNING" });
  }

  return milestones.sort((a, b) => a.milestoneSequence - b.milestoneSequence);
}

// ---------------------------------------------------------------------------
// Historical derivation — from durable history, not from today's snapshot
// ---------------------------------------------------------------------------

/**
 * One durable lifecycle event, as the notification runner reads it.
 *
 * `sequenceNumber` is the authoritative causal position: several events can
 * share a `createdAt` to the millisecond, so a timestamp must never be allowed
 * to decide their order.
 */
export interface LifecycleEventRecord {
  id: string;
  tradeExecutionId: string;
  sequenceNumber: number;
  eventType: string;
  toStatus: string | null;
  reasonCode: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
}

/** Supporting current state, used only to validate — never to supply a quantity. */
export interface ExecutionContext {
  symbol: string;
  direction: string;
  plannedEntryPrice: string;
  plannedQuantity: string;
  selectedLeverage: number;
  riskBudgetUsd: string;
  actualExitPrice: string | null;
  realizedPnl: string | null;
  tradingFeesUsd: string | null;
  fundingPnlUsd: string | null;
  decisionReasonCode: string | null;
  sanitizedMessage: string | null;
}

function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Milestones earned by ONE historical lifecycle event.
 *
 * This is the recovery path: quantities come from the metadata frozen ON THE
 * EVENT, so a runner that was offline across 0.10 -> 0.15 -> 0.25 still emits
 * PARTIAL_FILL 0.10 and PARTIAL_FILL 0.15 rather than only the final fill. A
 * later terminal state can never erase an earlier earned milestone, because the
 * earlier event is still sitting in the timeline waiting to be processed.
 *
 * `milestoneSequence` is carried from the event so recovered milestones deliver
 * in true lifecycle order.
 */
export function deriveMilestonesFromEvent(
  event: LifecycleEventRecord,
  context: ExecutionContext
): DerivedMilestone[] {
  const milestones: DerivedMilestone[] = [];
  const base = (type: ExecutionNotificationTypeName): NotificationPayload => ({
    type,
    symbol: context.symbol,
    direction: context.direction,
  });

  const push = (
    type: ExecutionNotificationTypeName,
    payload: NotificationPayload,
    options: { discriminator?: string; severity?: "INFO" | "WARNING" } = {}
  ): void => {
    milestones.push({
      type,
      dedupeKey: buildNotificationDedupeKey(event.tradeExecutionId, type, options.discriminator ?? ""),
      severity: options.severity ?? "INFO",
      // The event's own position in the lifecycle, so a batch recovered after
      // downtime replays in the order it actually happened.
      milestoneSequence: event.sequenceNumber,
      payload,
    });
  };

  const closure = (type: ExecutionNotificationTypeName): NotificationPayload => ({
    ...base(type),
    exitPrice: context.actualExitPrice,
    realizedPnl: context.realizedPnl,
    tradingFeesUsd: context.tradingFeesUsd,
    fundingPnlUsd: context.fundingPnlUsd,
    netPnlUsd: deriveNetPnl(context.realizedPnl, context.tradingFeesUsd, context.fundingPnlUsd),
  });

  // --- Entry reconciliation -----------------------------------------------
  if (event.eventType === "ENTRY_RECONCILED") {
    const localStatus = metadataString(event.metadata, "localOrderStatus");
    const filled = toDecimal(metadataString(event.metadata, "cumulativeFilledQuantity"));
    // The planned quantity as it was known at the event; the frozen plan is
    // immutable, so the context value is an equally valid fallback.
    const planned = toDecimal(metadataString(event.metadata, "plannedQuantity") ?? context.plannedQuantity);
    const averageFillPrice = metadataString(event.metadata, "averageFillPrice");

    if (localStatus !== null && ACCEPTED_ENTRY_ORDER_STATUSES.includes(localStatus)) {
      push("LIMIT_PLACED", {
        ...base("LIMIT_PLACED"),
        plannedEntryPrice: context.plannedEntryPrice,
        plannedQuantity: context.plannedQuantity,
        selectedLeverage: context.selectedLeverage,
        riskBudgetUsd: context.riskBudgetUsd,
      });
    }

    if (filled !== null && planned !== null && filled.greaterThan(0) && filled.lessThan(planned)) {
      const quantity = filled.toFixed();
      push(
        "PARTIAL_FILL",
        {
          ...base("PARTIAL_FILL"),
          filledQuantity: quantity,
          plannedQuantity: context.plannedQuantity,
          averageFillPrice,
        },
        { discriminator: canonicalQuantity(quantity) }
      );
    }

    if (localStatus === "FILLED" && filled !== null && filled.greaterThan(0)) {
      push("POSITION_FILLED", {
        ...base("POSITION_FILLED"),
        filledQuantity: filled.toFixed(),
        plannedQuantity: context.plannedQuantity,
        averageFillPrice,
      });
    }
  }

  // --- Terminal statuses ---------------------------------------------------
  // Driven by the status the event COMMITTED, so the milestone belongs to the
  // moment it was reached rather than to whatever the row says today.
  switch (event.toStatus) {
    case "ENTRY_EXPIRED":
      push("ENTRY_EXPIRED", base("ENTRY_EXPIRED"));
      break;
    case "CLOSED_TP":
      push("CLOSED_TP", closure("CLOSED_TP"));
      break;
    case "CLOSED_SL":
      push("CLOSED_SL", closure("CLOSED_SL"), { severity: "WARNING" });
      break;
    case "CLOSED_EMERGENCY":
      push("CLOSED_EMERGENCY", closure("CLOSED_EMERGENCY"), { severity: "WARNING" });
      break;
    case "SKIPPED":
      push(
        "TRADE_SKIPPED",
        {
          ...base("TRADE_SKIPPED"),
          // The event's own reason wins; it describes THIS decision.
          reasonCode: event.reasonCode ?? context.decisionReasonCode,
          explanation: event.message ?? context.sanitizedMessage,
        },
        { severity: "WARNING" }
      );
      break;
    default:
      break;
  }

  return milestones;
}

/** One durable proof that coverage was verified complete. */
export interface ProtectionVerificationRecord {
  id: string;
  tradeExecutionId: string;
  protectionVersion: number;
  state: string;
  confirmedOpenQuantity: string;
  protectedStopQuantity: string;
  protectedTakeProfitQuantity: string;
  liquidationSafe: boolean | null;
  stopTriggerPrice: string | null;
  takeProfitTriggerPrice: string | null;
}

/**
 * The POSITION_PROTECTED milestone earned by one historical verification.
 *
 * Every condition is re-checked against the frozen record rather than trusted:
 * a row that did not prove full STOP + TP coverage of a real exposure with
 * verified liquidation safety yields nothing, exactly as the live path.
 */
export function deriveMilestoneFromVerification(
  verification: ProtectionVerificationRecord,
  context: ExecutionContext
): DerivedMilestone | null {
  const covered = protectionIsFullyVerified({
    state: verification.state,
    confirmedOpenQuantity: verification.confirmedOpenQuantity,
    protectedStopQuantity: verification.protectedStopQuantity,
    protectedTakeProfitQuantity: verification.protectedTakeProfitQuantity,
    liquidationSafe: verification.liquidationSafe,
    stopTriggerPrice: verification.stopTriggerPrice,
    takeProfitTriggerPrice: verification.takeProfitTriggerPrice,
  });
  if (covered === null) return null;

  const quantity = covered.toFixed();
  return {
    type: "POSITION_PROTECTED",
    dedupeKey: buildNotificationDedupeKey(
      verification.tradeExecutionId,
      "POSITION_PROTECTED",
      canonicalQuantity(quantity)
    ),
    severity: "INFO",
    // Protection versions and execution sequence numbers are different spaces,
    // so protection milestones are ordered among themselves by protection
    // version and against the event timeline by creation order.
    milestoneSequence: verification.protectionVersion,
    payload: {
      type: "POSITION_PROTECTED",
      symbol: context.symbol,
      direction: context.direction,
      protectedQuantity: quantity,
      stopPrice: verification.stopTriggerPrice,
      takeProfitPrice: verification.takeProfitTriggerPrice,
    },
  };
}
