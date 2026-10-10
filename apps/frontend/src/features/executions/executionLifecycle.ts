import type { ExecutionDetail, ExecutionOrder, ExecutionTimelineEntry } from "../../api/executions.api";
import { presentExecutionStatus } from "./executionPresentation";

/**
 * An execution's lifecycle as ONE read-only line of steps:
 *
 *   plan / admission → entry order → entry fill → stop submitted → stop
 *   verified → take profit submitted → protected → reconciled → closed
 *
 * Pure. Built ONLY from durable, stored evidence the journal already returns:
 * the execution's own columns, its order rows, its protection state, its
 * safety admissions and its timeline's recorded status transitions. Nothing
 * is fetched from the exchange and nothing is inferred from time passing.
 *
 * A step is DONE only when a stored record proves it. A missing record is
 * NOT_RECORDED (unknown) when anything suggests the step may have happened,
 * NOT_REACHED only when the execution provably ended before it, and never
 * success. Timestamps come from the same record as the evidence.
 */

export const LIFECYCLE_STEP_IDS = [
  "ADMISSION",
  "ENTRY_ORDER",
  "ENTRY_FILL",
  "STOP_SUBMITTED",
  "STOP_VERIFIED",
  "TP_SUBMITTED",
  "PROTECTED",
  "RECONCILIATION",
  "CLOSE",
] as const;
export type LifecycleStepId = (typeof LIFECYCLE_STEP_IDS)[number];

export type LifecycleStepState =
  /** A stored record proves it happened. */
  | "DONE"
  /** A stored record proves it partly happened (a partial fill). */
  | "PARTIAL"
  /** A stored record shows it went wrong, or needs a human. */
  | "PROBLEM"
  /** The lifecycle stopped here on a recorded decision (an admission SKIP). */
  | "REFUSED"
  /** The execution is active and this is its next step. */
  | "IN_PROGRESS"
  /** The execution is active and has not got here yet. */
  | "PENDING"
  /** The execution provably ended before this step. */
  | "NOT_REACHED"
  /** No stored record of this step, although it may have happened: unknown, never assumed. */
  | "NOT_RECORDED"
  | "NOT_APPLICABLE";

export interface LifecycleStep {
  readonly id: LifecycleStepId;
  readonly label: string;
  readonly state: LifecycleStepState;
  /** Which record the state rests on, in words. */
  readonly detail: string;
  /** The evidence's own timestamp, when it has one. */
  readonly at: string | null;
}

export const LIFECYCLE_STEP_LABEL: Readonly<Record<LifecycleStepId, string>> = Object.freeze({
  ADMISSION: "Plan / admission",
  ENTRY_ORDER: "Entry order submitted",
  ENTRY_FILL: "Entry filled",
  STOP_SUBMITTED: "Stop submitted",
  STOP_VERIFIED: "Stop verified",
  TP_SUBMITTED: "Take profit submitted",
  PROTECTED: "Protected",
  RECONCILIATION: "Reconciled",
  CLOSE: "Closed / cleaned up",
});

const TERMINAL = new Set(["ENTRY_EXPIRED", "CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY", "CLOSED_EXTERNAL", "CANCELED", "SKIPPED", "FAILED"]);
/** Terminal statuses that can only follow an open position. */
const CLOSES_A_POSITION = new Set(["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY", "CLOSED_EXTERNAL"]);
const STOP_VERIFIED_STATES = new Set(["STOP_VERIFIED", "PLACING_TAKE_PROFIT", "PROTECTED"]);
/** The steps that happen in order; RECONCILIATION and CLOSE are judged on their own. */
const CHAIN: readonly LifecycleStepId[] = ["ADMISSION", "ENTRY_ORDER", "ENTRY_FILL", "STOP_SUBMITTED", "STOP_VERIFIED", "TP_SUBMITTED", "PROTECTED"];

type Found = { readonly state: "DONE" | "PARTIAL" | "PROBLEM" | "REFUSED" | "NOT_APPLICABLE"; readonly detail: string; readonly at: string | null };
interface Probe {
  readonly found: Found | null;
  /** Shown when nothing was found (what IS recorded short of the step). */
  readonly note: string | null;
}

const none = (note: string | null = null): Probe => ({ found: null, note });
const done = (detail: string, at: string | null): Probe => ({ found: { state: "DONE", detail, at }, note: null });

const sorted = (values: readonly (string | null)[]): string[] => values.filter((v): v is string => v !== null).sort();
const firstAt = (values: readonly (string | null)[]): string | null => sorted(values)[0] ?? null;
const lastAt = (values: readonly (string | null)[]): string | null => {
  const all = sorted(values);
  return all.length > 0 ? all[all.length - 1] : null;
};

function isPositive(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function orderProbe(orders: readonly ExecutionOrder[], noun: string): Probe {
  const submitted = orders.filter((order) => order.submittedAt !== null);
  if (submitted.length > 0) {
    const generations = new Set(submitted.map((order) => order.generation)).size;
    return done(`${noun} order submitted (${generations} generation${generations === 1 ? "" : "s"}; latest status ${submitted[submitted.length - 1].status})`, firstAt(submitted.map((o) => o.submittedAt)));
  }
  if (orders.some((order) => order.submissionUnknownAt !== null)) {
    return { found: { state: "PROBLEM", detail: `${noun} submission outcome is unknown`, at: firstAt(orders.map((o) => o.submissionUnknownAt)) }, note: null };
  }
  if (orders.some((order) => order.status === "REJECTED")) return { found: { state: "PROBLEM", detail: `${noun} order rejected`, at: null }, note: null };
  if (orders.length > 0) return none(`${noun} order reserved, not submitted`);
  return none();
}

export function deriveExecutionLifecycle(detail: ExecutionDetail, timeline: readonly ExecutionTimelineEntry[] | null): LifecycleStep[] {
  const events = timeline ?? [];
  const transitionAt = (status: string) => events.find((event) => event.toStatus === status)?.createdAt ?? null;
  const reached = (status: string) => detail.status === status || events.some((event) => event.toStatus === status);
  const terminal = TERMINAL.has(detail.status);
  const protection = detail.protection;
  const stops = detail.protectionOrders.filter((order) => order.role === "STOP_LOSS");
  const takeProfits = detail.protectionOrders.filter((order) => order.role === "TAKE_PROFIT");
  const allOrders = [detail.entryOrder, ...detail.protectionOrders, detail.emergencyCloseOrder].filter((o): o is ExecutionOrder => o !== null);

  const entryFill: Probe = (() => {
    if (detail.actual.entryFilledAt !== null) return done("Entry fully filled", detail.actual.entryFilledAt);
    if (reached("ENTRY_FILLED")) return done("Execution reached ENTRY_FILLED", transitionAt("ENTRY_FILLED"));
    if (detail.entryOrder?.status === "FILLED") return done("Entry order FILLED (as last reconciled)", detail.entryOrder.lastExchangeUpdateAt);
    if (detail.actual.firstFillAt !== null || reached("PARTIALLY_FILLED") || isPositive(detail.actual.filledQuantity)) {
      return {
        found: { state: "PARTIAL", detail: `Partially filled${detail.actual.filledQuantity ? ` (${detail.actual.filledQuantity} filled)` : ""}`, at: detail.actual.firstFillAt ?? transitionAt("PARTIALLY_FILLED") },
        note: null,
      };
    }
    return none();
  })();
  const filled = entryFill.found !== null;

  const probes: Record<LifecycleStepId, Probe> = {
    ADMISSION: (() => {
      const pass = detail.safetyAdmissions.find((admission) => admission.decision === "PASS") ?? null;
      if (pass) return done(`Safety admission PASS (version ${pass.evaluatedVersion})`, pass.evaluatedAt);
      const latest = detail.safetyAdmissions[0] ?? null;
      if (latest?.decision === "SKIP") {
        return { found: { state: "REFUSED", detail: `Safety admission SKIP${latest.reasonCode ? `: ${latest.reasonCode}` : ""}`, at: latest.evaluatedAt }, note: null };
      }
      if (latest) return none(`Latest admission decision: ${latest.decision}${latest.reasonCode ? ` (${latest.reasonCode})` : ""}`);
      return none("No admission decision is recorded");
    })(),

    ENTRY_ORDER: (() => {
      const at = detail.actual.entrySubmittedAt ?? detail.entryOrder?.submittedAt ?? null;
      if (at !== null) return done(`Entry order submitted${detail.entryOrder ? ` (order status ${detail.entryOrder.status})` : ""}`, at);
      return orderProbe(detail.entryOrder ? [detail.entryOrder] : [], "Entry");
    })(),

    ENTRY_FILL: entryFill,

    STOP_SUBMITTED: orderProbe(stops, "Stop"),

    STOP_VERIFIED: (() => {
      if (protection && STOP_VERIFIED_STATES.has(protection.state)) return done(`Protection state ${protection.state}`, protection.verifiedAt);
      if (protection && isPositive(protection.protectedStopQuantity)) return done(`Verified stop coverage ${protection.protectedStopQuantity}`, protection.verifiedAt);
      if (reached("PROTECTED")) return done("Execution reached PROTECTED, which requires a verified stop", transitionAt("PROTECTED"));
      const filledStop = stops.find((order) => order.status === "FILLED");
      if (filledStop) return done("Stop order FILLED on the exchange (as last reconciled)", filledStop.lastExchangeUpdateAt);
      return none();
    })(),

    TP_SUBMITTED:
      detail.planned.takeProfit === null
        ? { found: { state: "NOT_APPLICABLE", detail: "No take profit was planned", at: null }, note: null }
        : orderProbe(takeProfits, "Take profit"),

    PROTECTED: (() => {
      if (protection?.state === "PROTECTION_INCOMPLETE") return { found: { state: "PROBLEM", detail: "Protection incomplete", at: protection.verifiedAt }, note: null };
      if (reached("PROTECTED")) return done("Execution reached PROTECTED", transitionAt("PROTECTED") ?? detail.actual.protectionPlacedAt);
      if (protection?.state === "PROTECTED") return done("Protection state PROTECTED", protection.verifiedAt);
      if (detail.actual.protectionPlacedAt !== null) return done("Protection placed", detail.actual.protectionPlacedAt);
      return none();
    })(),

    RECONCILIATION: (() => {
      if (detail.lastReconciledAt !== null) return done("Last reconciled", detail.lastReconciledAt);
      const orderReconcile = lastAt(allOrders.map((order) => order.lastReconcileAt));
      if (orderReconcile !== null) return done("Orders last reconciled", orderReconcile);
      return none();
    })(),

    CLOSE: (() => {
      if (detail.status === "MANUAL_INTERVENTION" || detail.requiresManualIntervention) {
        return { found: { state: "PROBLEM", detail: "Manual intervention required", at: null }, note: null };
      }
      if (protection?.state === "EMERGENCY_CLOSING") return { found: { state: "PROBLEM", detail: "Emergency closing in progress", at: null }, note: null };
      if (protection?.state === "CLOSURE_CLEANUP") return { found: { state: "PROBLEM", detail: "Closed, but cleanup is incomplete", at: detail.actual.closedAt }, note: null };
      // Ended after a fill without a position-closing status or a close time: whether the position closed is unknown.
      if (terminal && filled && !CLOSES_A_POSITION.has(detail.status) && detail.actual.closedAt === null) {
        return none(`The execution ended ${detail.status} after a fill, and no close is recorded`);
      }
      if (terminal) {
        const exit = detail.actual.exitReason ? ` · ${detail.actual.exitReason}` : "";
        const cleanup = protection?.state === "CLOSED" ? " · protection closed" : "";
        const when = detail.actual.closedAt === null ? " · close time not recorded" : "";
        return done(`Ended: ${presentExecutionStatus(detail.status).label}${exit}${cleanup}${when}`, detail.actual.closedAt);
      }
      return none();
    })(),
  };

  const evidenced = (id: LifecycleStepId) => {
    const found = probes[id].found;
    return found !== null && found.state !== "NOT_APPLICABLE";
  };
  const refusedAtAdmission = probes.ADMISSION.found?.state === "REFUSED";
  // Ended without ever holding a position, by its own status and the absence of any fill record.
  const endedWithoutPosition = terminal && !CLOSES_A_POSITION.has(detail.status) && !filled;
  const anyOrderSubmitted = allOrders.some((order) => order.submittedAt !== null);
  let nextMarked = false;

  return LIFECYCLE_STEP_IDS.map((id): LifecycleStep => {
    const probe = probes[id];
    const label = LIFECYCLE_STEP_LABEL[id];
    if (probe.found !== null) return { id, label, state: probe.found.state, detail: probe.found.detail, at: probe.found.at };
    const note = probe.note === null ? "" : ` ${probe.note}.`;

    if (id === "RECONCILIATION") {
      if (terminal && !anyOrderSubmitted) return { id, label, state: "NOT_REACHED", detail: `Nothing was submitted, so there was nothing to reconcile.${note}`, at: null };
      if (!terminal && !anyOrderSubmitted) return { id, label, state: "PENDING", detail: `Nothing submitted yet.${note}`, at: null };
      return { id, label, state: "NOT_RECORDED", detail: `No reconciliation is recorded.${note}`, at: null };
    }
    if (id === "CLOSE") {
      if (terminal) return { id, label, state: "NOT_RECORDED", detail: note.trim() || "No close is recorded.", at: null };
      return { id, label, state: "PENDING", detail: "Still open.", at: null };
    }

    const index = CHAIN.indexOf(id);
    if (CHAIN.slice(index + 1).some(evidenced)) {
      return { id, label, state: "NOT_RECORDED", detail: `No stored record of this step, although a later step is recorded.${note}`, at: null };
    }
    if (terminal) {
      if (id === "ADMISSION") return { id, label, state: "NOT_RECORDED", detail: `Plan created ${detail.createdAt}; the execution ended ${detail.status}${detail.decisionReasonCode ? ` (${detail.decisionReasonCode})` : ""}.${note}`, at: null };
      if (refusedAtAdmission || endedWithoutPosition) return { id, label, state: "NOT_REACHED", detail: `The execution ended (${detail.status}) before this step.${note}`, at: null };
      return { id, label, state: "NOT_RECORDED", detail: `The execution ended (${detail.status}) but this step has no stored record.${note}`, at: null };
    }
    if (!nextMarked && detail.status !== "MANUAL_INTERVENTION") {
      nextMarked = true;
      return { id, label, state: "IN_PROGRESS", detail: `Next step for this active execution.${note}`, at: null };
    }
    return { id, label, state: "PENDING", detail: `Not reached yet.${note}`, at: null };
  });
}

export interface LifecycleStatePresentation {
  readonly label: string;
  readonly tone: "green" | "red" | "yellow" | "gray" | "blue";
  /** A textual marker so a state is never told by colour alone. */
  readonly marker: string;
}

const STATE_PRESENTATION: Readonly<Record<LifecycleStepState, LifecycleStatePresentation>> = Object.freeze({
  DONE: { label: "Recorded", tone: "green", marker: "✓" },
  PARTIAL: { label: "Partial", tone: "yellow", marker: "◐" },
  PROBLEM: { label: "Problem", tone: "red", marker: "!" },
  REFUSED: { label: "Refused", tone: "gray", marker: "■" },
  IN_PROGRESS: { label: "In progress", tone: "blue", marker: "…" },
  PENDING: { label: "Pending", tone: "gray", marker: "·" },
  NOT_REACHED: { label: "Not reached", tone: "gray", marker: "–" },
  NOT_RECORDED: { label: "Not recorded", tone: "yellow", marker: "?" },
  NOT_APPLICABLE: { label: "Not applicable", tone: "gray", marker: "–" },
});

export function presentLifecycleState(state: LifecycleStepState): LifecycleStatePresentation {
  return STATE_PRESENTATION[state];
}
