import { Prisma, type NativeAlertDelivery, type PrismaClient } from "@prisma/client";

import { NATIVE_ALERT_SOURCE } from "../alerts/alert-source";
import { buildNativeAlertDraft, buildNativeAlertDraftV2 } from "./native-alert-draft";
import type { NativeDeliveryDecision } from "./native-delivery-policy";
import type { NativeDeliveryContextV2, NativeDeliveryDecisionV2 } from "./native-delivery-policy-v2";

/**
 * The native emitter's database side: the delivery LEDGER and the Alert it
 * guards, and nothing else. It writes exactly two tables — `Alert` (always
 * source NATIVE) and `NativeAlertDelivery` — and never a plan, a queue job, a
 * notification, an adoption, an execution or anything an account can see.
 *
 * Exactly-once per delivery key comes from the database:
 *  - the ledger row and its Alert are created in ONE transaction, so there is
 *    never an Alert without its key or a key without its Alert;
 *  - `deliveryKey` is UNIQUE, so of two racing emitters (or one emitter
 *    re-reading its log after a crash) exactly one insert commits and the
 *    other's whole transaction — its Alert included — rolls back;
 *  - the loser then reads the winner's row and adopts it only if it records
 *    the SAME provenance. A different winning observation, policy or bar under
 *    the same key is a contradiction, and the emitter stops on it.
 */

export type NativeDeliveryOutcome =
  /** This call created the Alert and its ledger row. */
  | "CREATED"
  /** The key was already delivered with identical provenance; nothing was written. */
  | "ALREADY_DELIVERED"
  /** Already delivered, and that Alert was later deleted by an operator. The bar stays delivered. */
  | "ALREADY_DELIVERED_ALERT_REMOVED"
  /**
   * V2 only: this exact canonical shadow event was already delivered under ANOTHER
   * policy version (a V1 row). Nothing was written: a policy version never
   * re-delivers an event, and a deleted Alert never comes back through it.
   */
  | "ALREADY_DELIVERED_UNDER_OTHER_POLICY";

export interface NativeDeliveryResult {
  readonly outcome: NativeDeliveryOutcome;
  readonly deliveryKey: string;
  readonly alertId: string | null;
}

export type NativeLookupResult =
  | { readonly state: "NOT_DELIVERED" }
  | { readonly state: "DELIVERED"; readonly alertId: string | null };

export interface NativeLedgerStatus {
  readonly available: boolean;
  /** Ledger rows for this lineage/symbol/interval; null when unavailable. */
  readonly delivered: number | null;
  readonly detail: string;
}

export class NativeDeliveryConflictError extends Error {
  readonly code = "PROVENANCE_CONTRADICTION";

  constructor(deliveryKey: string, field: string) {
    super(`delivery key ${deliveryKey} already exists with a different ${field}: refusing to reuse or overwrite it`);
    this.name = "NativeDeliveryConflictError";
  }
}

/** What the emitter needs from a ledger. The Prisma one below is the only real one. */
export interface NativeDeliveryLedger {
  status(scope: { lineageId: string; symbol: string; chartInterval: string }): Promise<NativeLedgerStatus>;
  /** Read-only. Also verifies provenance of an existing key. */
  lookup(decision: NativeDeliveryDecision): Promise<NativeLookupResult>;
  /** The only write. */
  deliver(decision: NativeDeliveryDecision): Promise<NativeDeliveryResult>;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** The provenance fields every policy version records; what an existing row is compared on. */
interface ComparableDecision {
  readonly deliveryKey: string;
  readonly provenanceSha256: string;
  readonly provenance: {
    readonly policyVersion: string;
    readonly deliveryKeySchema: string;
    readonly lineageId: string;
    readonly marketType: string;
    readonly symbol: string;
    readonly chartInterval: string;
    readonly barOpenTimeMs: number;
    readonly winningShadowEventId: string;
    readonly evidenceClass: string;
  };
}

/** The fields an existing ledger row must agree on before it may be adopted. */
export function assertSameProvenance(existing: NativeAlertDelivery, decision: ComparableDecision): void {
  const p = decision.provenance;
  const checks: Array<[string, unknown, unknown]> = [
    ["provenance", existing.provenanceSha256, decision.provenanceSha256],
    ["policy version", existing.policyVersion, p.policyVersion],
    ["key schema", existing.deliveryKeySchema, p.deliveryKeySchema],
    ["lineage", existing.lineageId, p.lineageId],
    ["market", existing.marketType, p.marketType],
    ["symbol", existing.symbol, p.symbol],
    ["chart interval", existing.chartInterval, p.chartInterval],
    ["bar", existing.barOpenTime.getTime(), p.barOpenTimeMs],
    ["winning shadow event", existing.winningShadowEventId, p.winningShadowEventId],
    ["evidence class", existing.evidenceClass, p.evidenceClass],
  ];
  for (const [field, stored, expected] of checks) {
    if (stored !== expected) throw new NativeDeliveryConflictError(decision.deliveryKey, field);
  }
}

function adopt(existing: NativeAlertDelivery, decision: ComparableDecision): NativeDeliveryResult {
  assertSameProvenance(existing, decision);
  return {
    outcome: existing.alertId === null ? "ALREADY_DELIVERED_ALERT_REMOVED" : "ALREADY_DELIVERED",
    deliveryKey: decision.deliveryKey,
    alertId: existing.alertId,
  };
}

/** The V2 ledger surface: the same table, the same unique key, one extra guard. */
export interface NativeDeliveryLedgerV2 {
  /** Read-only, including the cross-version check. */
  lookupV2(decision: NativeDeliveryDecisionV2): Promise<NativeLookupResult>;
  /** The only V2 write. */
  deliverV2(decision: NativeDeliveryDecisionV2, context: NativeDeliveryContextV2): Promise<NativeDeliveryResult>;
}

/** A row for the same canonical shadow event under a DIFFERENT delivery key (another policy version). */
function otherPolicyWhere(decision: NativeDeliveryDecisionV2) {
  const p = decision.provenance;
  return {
    lineageId: p.lineageId,
    symbol: p.symbol,
    chartInterval: p.chartInterval,
    barOpenTime: new Date(p.barOpenTimeMs),
    winningShadowEventId: p.winningShadowEventId,
    deliveryKey: { not: decision.deliveryKey },
  };
}

export class PrismaNativeDeliveryLedger implements NativeDeliveryLedger, NativeDeliveryLedgerV2 {
  constructor(private readonly prisma: PrismaClient) {}

  async status(scope: { lineageId: string; symbol: string; chartInterval: string }): Promise<NativeLedgerStatus> {
    try {
      // Both halves of the migration must be present: the ledger table and Alert.source.
      const [delivered, nativeAlerts] = await Promise.all([
        this.prisma.nativeAlertDelivery.count({ where: scope }),
        this.prisma.alert.count({ where: { source: NATIVE_ALERT_SOURCE, symbol: scope.symbol } }),
      ]);
      return { available: true, delivered, detail: `ledger rows ${delivered}, native alerts for symbol ${nativeAlerts}` };
    } catch (error) {
      const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : "UNKNOWN";
      return {
        available: false,
        delivered: null,
        detail: code === "P2021" || code === "P2022" ? "migration not applied (table or column missing)" : `ledger unreachable (${code})`,
      };
    }
  }

  async lookup(decision: NativeDeliveryDecision): Promise<NativeLookupResult> {
    const existing = await this.prisma.nativeAlertDelivery.findUnique({ where: { deliveryKey: decision.deliveryKey } });
    if (existing === null) return { state: "NOT_DELIVERED" };
    assertSameProvenance(existing, decision);
    return { state: "DELIVERED", alertId: existing.alertId };
  }

  async deliver(decision: NativeDeliveryDecision): Promise<NativeDeliveryResult> {
    const existing = await this.prisma.nativeAlertDelivery.findUnique({ where: { deliveryKey: decision.deliveryKey } });
    if (existing !== null) return adopt(existing, decision);

    const draft = buildNativeAlertDraft(decision);
    const p = decision.provenance;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const alert = await tx.alert.create({ data: draft, select: { id: true } });
        await tx.nativeAlertDelivery.create({
          data: {
            deliveryKey: decision.deliveryKey,
            deliveryKeySchema: p.deliveryKeySchema,
            policyVersion: p.policyVersion,
            lineageId: p.lineageId,
            marketType: p.marketType,
            symbol: p.symbol,
            chartInterval: p.chartInterval,
            barOpenTime: new Date(p.barOpenTimeMs),
            winningShadowEventId: p.winningShadowEventId,
            evidenceClass: p.evidenceClass,
            provenanceSha256: decision.provenanceSha256,
            alertId: alert.id,
          },
        });
        return { outcome: "CREATED" as const, deliveryKey: decision.deliveryKey, alertId: alert.id };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Another emitter committed this key first; our transaction, Alert included, rolled back.
      const winner = await this.prisma.nativeAlertDelivery.findUnique({ where: { deliveryKey: decision.deliveryKey } });
      if (winner === null) throw error;
      return adopt(winner, decision);
    }
  }

  async lookupV2(decision: NativeDeliveryDecisionV2): Promise<NativeLookupResult> {
    const existing = await this.prisma.nativeAlertDelivery.findUnique({ where: { deliveryKey: decision.deliveryKey } });
    if (existing !== null) {
      assertSameProvenance(existing, decision);
      return { state: "DELIVERED", alertId: existing.alertId };
    }
    const other = await this.prisma.nativeAlertDelivery.findFirst({ where: otherPolicyWhere(decision) });
    return other === null ? { state: "NOT_DELIVERED" } : { state: "DELIVERED", alertId: other.alertId };
  }

  async deliverV2(decision: NativeDeliveryDecisionV2, context: NativeDeliveryContextV2): Promise<NativeDeliveryResult> {
    const existing = await this.prisma.nativeAlertDelivery.findUnique({ where: { deliveryKey: decision.deliveryKey } });
    if (existing !== null) return adopt(existing, decision);

    const draft = buildNativeAlertDraftV2(decision, context);
    const p = decision.provenance;
    try {
      return await this.prisma.$transaction(async (tx) => {
        // The same canonical event already delivered under another policy (e.g. V1): write nothing.
        const other = await tx.nativeAlertDelivery.findFirst({ where: otherPolicyWhere(decision) });
        if (other !== null) {
          return { outcome: "ALREADY_DELIVERED_UNDER_OTHER_POLICY" as const, deliveryKey: decision.deliveryKey, alertId: other.alertId };
        }
        const alert = await tx.alert.create({ data: draft, select: { id: true } });
        await tx.nativeAlertDelivery.create({
          data: {
            deliveryKey: decision.deliveryKey,
            deliveryKeySchema: p.deliveryKeySchema,
            policyVersion: p.policyVersion,
            lineageId: p.lineageId,
            marketType: p.marketType,
            symbol: p.symbol,
            chartInterval: p.chartInterval,
            barOpenTime: new Date(p.barOpenTimeMs),
            winningShadowEventId: p.winningShadowEventId,
            evidenceClass: p.evidenceClass,
            provenanceSha256: decision.provenanceSha256,
            alertId: alert.id,
          },
        });
        return { outcome: "CREATED" as const, deliveryKey: decision.deliveryKey, alertId: alert.id };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.prisma.nativeAlertDelivery.findUnique({ where: { deliveryKey: decision.deliveryKey } });
      if (winner === null) throw error;
      return adopt(winner, decision);
    }
  }
}
