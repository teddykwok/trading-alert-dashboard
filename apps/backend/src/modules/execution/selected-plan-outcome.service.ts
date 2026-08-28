import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { SelectedPlanOutcome } from "./selected-plan-executor";

/**
 * Durable evidence of what the selected-plan executor decided.
 *
 * ## Why this exists
 *
 * Every refusal in `SelectedPlanExecutor.handleSelectedPlan` returns BEFORE a
 * TradeExecution is created — eleven return sites across nine reason codes.
 * Neither `ExecutionEvent` nor `SafetyAdmission` can record them, because both
 * require a `tradeExecutionId` that by definition does not exist yet. So the
 * decision was only ever logged, and Alert Detail could say nothing better than
 * "reason unavailable" for an alert whose plan was READY and which produced no
 * execution.
 *
 * ## Why it is a separate module, called from the WORKER
 *
 * This is the load-bearing design decision, and it is about safety rather than
 * tidiness. `handleSelectedPlan` already RETURNS its outcome, so the evidence
 * can be persisted at the call site, strictly after the decision has been made
 * and handed back. That means:
 *
 *   - `selected-plan-executor.ts` is not modified at all;
 *   - no persistence runs inside a trading decision, or inside its transaction;
 *   - a write failure here cannot reverse, re-run or alter a decision that has
 *     already been returned to the caller.
 *
 * The alternative — writing from inside the executor — would put an
 * observability failure on the same path as a refusal, where a throw could turn
 * "refuse safely" into "job retries and decides again later, against different
 * state". Keeping the write outside removes that possibility structurally
 * instead of relying on a try/catch to contain it.
 *
 * ## Observability only
 *
 * Nothing reads these rows to decide anything. Dropping the whole table would
 * change no trading behaviour.
 */

export interface RecordSelectedPlanOutcomeInput {
  alertId: string;
  extremeRRPlanId: string;
  outcome: SelectedPlanOutcome;
  evaluatedAt: Date;
}

export interface PersistedSelectedPlanOutcome {
  handled: boolean;
  reasonCode: string | null;
  message: string | null;
  executionId: string | null;
  evaluatedAt: Date;
}

/** The canonical shape stored, derived only from what the executor returned. */
function toRow(outcome: SelectedPlanOutcome): {
  handled: boolean;
  reasonCode: string | null;
  message: string | null;
  executionId: string | null;
} {
  if (outcome.handled) {
    return {
      handled: true,
      reasonCode: outcome.reasonCode,
      // A handled outcome carries no sentence of its own; the execution row is
      // authoritative for it and inventing prose here would be a second,
      // divergent description of the same event.
      message: null,
      executionId: outcome.executionId,
    };
  }
  return {
    handled: false,
    // Stored verbatim. The reason code is the canonical value the rest of the
    // system already speaks; re-interpreting it here would create a second
    // vocabulary that could drift from the first.
    reasonCode: outcome.reasonCode,
    message: outcome.message,
    executionId: null,
  };
}

/**
 * Records the decision for one alert's plan.
 *
 * ## One row, replaced rather than appended
 *
 * `ExtremeRRPlan.alertId` is unique and a READY plan is FROZEN —
 * `generateForAlert` returns an existing READY plan untouched rather than
 * regenerating it. So a redelivered job or a second worker re-decides the SAME
 * immutable plan from the same inputs, and appending would manufacture a
 * history of "repeated decisions" that never happened.
 *
 * A non-READY plan may legitimately regenerate and be evaluated again. There
 * the newer verdict replaces one whose subject no longer exists, which is why
 * `evaluatedAt` is stored: the row always says when the decision it describes
 * was actually taken.
 *
 * ## Concurrency
 *
 * Two workers racing produce one row, decided by the database rather than by
 * timing. `upsert` can still lose a create race, so P2002 is caught and
 * retried as an update — no lock, and no path by which a constraint violation
 * could reach a trading decision.
 */
export async function recordSelectedPlanOutcome(
  prisma: PrismaClient,
  input: RecordSelectedPlanOutcomeInput
): Promise<void> {
  const row = toRow(input.outcome);
  const data = {
    extremeRRPlanId: input.extremeRRPlanId,
    handled: row.handled,
    reasonCode: row.reasonCode,
    message: row.message?.slice(0, 1000) ?? null,
    executionId: row.executionId,
    evaluatedAt: input.evaluatedAt,
  };

  try {
    await prisma.selectedPlanOutcome.upsert({
      where: { alertId: input.alertId },
      create: { alertId: input.alertId, ...data },
      update: data,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // A concurrent writer created the row between our read and our insert.
      // Its decision and ours describe the same evaluation of the same frozen
      // plan, so converging on one row is correct rather than a conflict.
      await prisma.selectedPlanOutcome.update({ where: { alertId: input.alertId }, data });
      return;
    }
    throw error;
  }
}

/** Reads the stored verdict, or null when none was ever recorded. */
export async function findSelectedPlanOutcome(
  prisma: PrismaClient,
  alertId: string
): Promise<PersistedSelectedPlanOutcome | null> {
  const row = await prisma.selectedPlanOutcome.findUnique({ where: { alertId } });
  if (!row) return null;
  return {
    handled: row.handled,
    reasonCode: row.reasonCode,
    message: row.message,
    executionId: row.executionId,
    evaluatedAt: row.evaluatedAt,
  };
}
