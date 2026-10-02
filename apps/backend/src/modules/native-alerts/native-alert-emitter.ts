import type { ShadowRecord } from "../native-scanner/live-shadow-store";
import type { NativeDeliveryLedger, NativeDeliveryOutcome } from "./native-alert-ledger";
import { NativeDeliverySelector, type NativeDeliveryDecision, type NativeSkipReason } from "./native-delivery-policy";
import type { ShadowLogTail } from "./shadow-log-reader";

/**
 * The native alert emitter's core: durable shadow records in, NATIVE_DELIVERY_V1
 * decisions out, and — only in COMMIT mode — one ledger-guarded dashboard Alert
 * per decision.
 *
 * Everything it touches is injected: the log text, the ledger, the clock-free
 * sleep. It holds no credential, opens no socket, enqueues nothing and notifies
 * no one. DRY_RUN never calls `deliver`; it can only look a key up.
 */

export type NativeEmitterMode = "DRY_RUN" | "COMMIT_DASHBOARD_ALERTS";

export type NativeEmitterEvent =
  | { readonly type: "SKIPPED"; readonly eventId: string; readonly reason: NativeSkipReason; readonly supersededBy: string | null }
  | {
      readonly type: "DECISION";
      readonly mode: NativeEmitterMode;
      /** COMMIT: what the ledger did. DRY_RUN: WOULD_CREATE / ALREADY_DELIVERED / LEDGER_NOT_CHECKED. */
      readonly result: NativeDeliveryOutcome | "WOULD_CREATE" | "LEDGER_NOT_CHECKED";
      readonly alertId: string | null;
      readonly decision: NativeDeliveryDecision;
    };

export interface NativeEmitterTally {
  records: number;
  decisions: number;
  created: number;
  alreadyDelivered: number;
  wouldCreate: number;
  skipped: Partial<Record<NativeSkipReason, number>>;
}

export interface NativeAlertEmitterDeps {
  readonly mode: NativeEmitterMode;
  /** Null only in DRY_RUN when the ledger is unavailable: decisions are then reported unchecked. */
  readonly ledger: NativeDeliveryLedger | null;
  readonly report: (event: NativeEmitterEvent) => void;
}

export class NativeAlertEmitter {
  private readonly selector = new NativeDeliverySelector();
  readonly tally: NativeEmitterTally = { records: 0, decisions: 0, created: 0, alreadyDelivered: 0, wouldCreate: 0, skipped: {} };

  constructor(private readonly deps: NativeAlertEmitterDeps) {
    if (deps.mode === "COMMIT_DASHBOARD_ALERTS" && deps.ledger === null) {
      throw new Error("COMMIT mode requires an available delivery ledger");
    }
  }

  /** Strictly sequential, in log order: decision N is durable before record N+1 is considered. */
  async process(records: readonly ShadowRecord[]): Promise<void> {
    for (const record of records) {
      this.tally.records += 1;
      const selection = this.selector.consider(record);
      if (selection.kind === "SKIP") {
        this.tally.skipped[selection.reason] = (this.tally.skipped[selection.reason] ?? 0) + 1;
        this.deps.report({ type: "SKIPPED", eventId: selection.eventId, reason: selection.reason, supersededBy: selection.supersededBy });
        continue;
      }
      this.tally.decisions += 1;
      const decision = selection.decision;
      const ledger = this.deps.ledger;

      if (this.deps.mode === "COMMIT_DASHBOARD_ALERTS" && ledger !== null) {
        const result = await ledger.deliver(decision);
        if (result.outcome === "CREATED") this.tally.created += 1;
        else this.tally.alreadyDelivered += 1;
        this.deps.report({ type: "DECISION", mode: this.deps.mode, result: result.outcome, alertId: result.alertId, decision });
        continue;
      }

      // DRY_RUN: read-only from here on.
      if (ledger === null) {
        this.tally.wouldCreate += 1;
        this.deps.report({ type: "DECISION", mode: this.deps.mode, result: "LEDGER_NOT_CHECKED", alertId: null, decision });
        continue;
      }
      const found = await ledger.lookup(decision);
      if (found.state === "DELIVERED") {
        this.tally.alreadyDelivered += 1;
        this.deps.report({
          type: "DECISION",
          mode: this.deps.mode,
          result: found.alertId === null ? "ALREADY_DELIVERED_ALERT_REMOVED" : "ALREADY_DELIVERED",
          alertId: found.alertId,
          decision,
        });
      } else {
        this.tally.wouldCreate += 1;
        this.deps.report({ type: "DECISION", mode: this.deps.mode, result: "WOULD_CREATE", alertId: null, decision });
      }
    }
  }
}

export interface NativeEmitterLoopDeps {
  readonly tail: ShadowLogTail;
  /** The whole current log, or null when it does not exist yet. */
  readonly readLog: () => string | null;
  readonly emitter: NativeAlertEmitter;
  readonly follow: boolean;
  readonly pollMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly shouldStop: () => boolean;
  readonly onCaughtUp?: () => void;
}

/**
 * Catch up on the whole durable log from its first byte, then (follow mode)
 * poll for appended records. Restart-safe by construction: re-reading from the
 * start re-derives the same decisions, and the ledger turns every one already
 * delivered into ALREADY_DELIVERED. Any refusal propagates and stops the loop.
 */
export async function runNativeEmitterLoop(deps: NativeEmitterLoopDeps): Promise<void> {
  await deps.emitter.process(deps.tail.read(deps.readLog()));
  deps.onCaughtUp?.();
  if (!deps.follow) return;
  while (!deps.shouldStop()) {
    await deps.sleep(deps.pollMs);
    if (deps.shouldStop()) break;
    await deps.emitter.process(deps.tail.read(deps.readLog()));
  }
}
