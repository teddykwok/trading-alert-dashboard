import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

import { AppError } from "../../utils/errors";
import {
  NATIVE_FINISHED_STATUSES,
  POSSIBLY_LIVE_ENTRY_ORDER_STATUSES,
  judgeSameSymbolSideOccupancy,
  type NativeOccupancyRow,
} from "./native-account-a-canary";

/**
 * NATIVE OCCUPANCY RESERVATION: the serialization point for
 * (account, symbol, side).
 *
 * The adoption claim is per PLAN, so it cannot stop two DIFFERENT Native plans
 * for the same account, symbol and side (a 1D and a 1W touch on one bar, say)
 * from both passing the decision's occupancy check, which is only a read. What
 * actually establishes occupancy is the TradeExecution row, and there is
 * exactly one place that creates one: ExecutionService.createExecutionFromReadyPlan.
 *
 * So the Native branch of that creation calls `reserveNativeOccupancy` INSIDE
 * its own transaction, immediately before the insert. It:
 *
 *   1. takes a transaction-scoped advisory lock keyed by (profile, symbol,
 *      side), so two Native creations for the same key run one at a time;
 *   2. re-reads occupancy under that lock;
 *   3. refuses (throws, rolling the transaction back) unless the slot is free.
 *
 * The lock is held until the insert commits, so the second creation re-reads
 * AFTER the first one's row is visible. At most one can establish occupancy,
 * and the loser always fails the same way: SAME_SYMBOL_SIDE_OCCUPIED (or
 * AMBIGUOUS_STATE).
 *
 * The candidate's own execution (same alert, same profile) is never its own
 * occupant. That keeps a retry idempotent: it either returns the existing row
 * or loses the unique (alertId, profile) race. It is never refused against
 * itself.
 *
 * TradingView creation does not take this lock and is unchanged. Phase 5's
 * profile lock and SYMBOL_SIDE_ALREADY_ACTIVE, and the entry lifecycle's
 * symbol-level exclusion, still govern every execution, including this one.
 */

/** Advisory-lock namespace. Distinct from every other one (0x5afe, 0x5afe6, 0x7afe, 0x11b0, 0xf111). */
export const NATIVE_OCCUPANCY_LOCK_NAMESPACE = 0xa7e1;

/** Stable 32-bit key for one (profile, symbol, side). */
export function nativeOccupancyLockKey(executionProfileId: string, symbol: string, positionSide: string): number {
  return createHash("sha256")
    .update(`${executionProfileId}:${symbol.trim().toUpperCase()}:${positionSide.trim().toUpperCase()}`)
    .digest()
    .readInt32BE(0);
}

type OccupancyClient = Pick<PrismaClient, "tradeExecution"> | Prisma.TransactionClient;

/**
 * Every local execution of this profile on the symbol that could hold it: any
 * unfinished one, any flagged for a human, and any finished one whose entry
 * order might still be live. Durable local state only, never the exchange.
 */
export async function loadNativeOccupancyRows(client: OccupancyClient, executionProfileId: string, symbol: string): Promise<NativeOccupancyRow[]> {
  const rows = await client.tradeExecution.findMany({
    where: {
      executionProfileId,
      symbol: { equals: symbol.trim(), mode: "insensitive" },
      OR: [
        { status: { notIn: [...NATIVE_FINISHED_STATUSES] } },
        { requiresManualIntervention: true },
        {
          orders: {
            some: {
              role: "ENTRY",
              OR: [{ status: { in: [...POSSIBLY_LIVE_ENTRY_ORDER_STATUSES] } }, { submissionUnknownAt: { not: null } }],
            },
          },
        },
      ],
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      alertId: true,
      symbol: true,
      status: true,
      direction: true,
      positionSide: true,
      requiresManualIntervention: true,
      orders: { where: { role: "ENTRY" }, select: { status: true, submissionUnknownAt: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    alertId: row.alertId,
    symbol: row.symbol,
    status: row.status,
    direction: row.direction,
    positionSide: row.positionSide,
    requiresManualIntervention: row.requiresManualIntervention,
    entryOrders: row.orders.map((order) => ({ status: order.status, submissionUnknown: order.submissionUnknownAt !== null })),
  }));
}

/** Another execution holds, or ambiguously may hold, this account's symbol + side. */
export class NativeOccupancyConflictError extends AppError {
  readonly code = "NATIVE_OCCUPANCY_CONFLICT";

  constructor(
    readonly reasonCode: "SAME_SYMBOL_SIDE_OCCUPIED" | "AMBIGUOUS_STATE",
    readonly holderExecutionId: string | null,
    detail: string
  ) {
    super(detail, 409);
    this.name = "NativeOccupancyConflictError";
  }
}

/**
 * Lock, re-read, judge, inside the caller's transaction. Returns only when the
 * slot is free; the caller then inserts in the same transaction.
 */
export async function reserveNativeOccupancy(
  tx: Prisma.TransactionClient,
  slot: { readonly executionProfileId: string; readonly symbol: string; readonly positionSide: string; readonly alertId: string }
): Promise<void> {
  if (slot.positionSide !== "LONG" && slot.positionSide !== "SHORT") {
    throw new NativeOccupancyConflictError("AMBIGUOUS_STATE", null, `Position side ${slot.positionSide} cannot be attributed to one side.`);
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NATIVE_OCCUPANCY_LOCK_NAMESPACE}::int, ${nativeOccupancyLockKey(
    slot.executionProfileId,
    slot.symbol,
    slot.positionSide
  )}::int)`;
  const rows = await loadNativeOccupancyRows(tx, slot.executionProfileId, slot.symbol);
  const verdict = judgeSameSymbolSideOccupancy(rows, { symbol: slot.symbol, positionSide: slot.positionSide, alertId: slot.alertId });
  if (verdict.occupied) throw new NativeOccupancyConflictError(verdict.reasonCode, verdict.executionId, verdict.detail);
}
