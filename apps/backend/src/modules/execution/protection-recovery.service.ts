import type { PrismaClient, TradeExecution } from "@prisma/client";

import type { BoundExecutionProfileProjection } from "./exchange-runtime-binding";

import type { BinanceReadOnlyService } from "../binance/binance-read-only.service";
import { connectorEnvironmentMatches } from "../binance/binance-environment";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import {
  normalizeOpenQuantity,
  protectionPositionSide,
  validateProtectionTriggers,
  type DirectionName,
} from "./protection-lifecycle";
import type { ProtectionLifecycleService } from "./protection-lifecycle.service";
import {
  RECOVERABLE_PROTECTION_REASON,
  gathered,
  judgeProtectionRecovery,
  summarizeProtectionRecovery,
  unavailable,
  type EvidenceFact,
  type ProtectionRecoveryEvidence,
  type ProtectionRecoveryVerdict,
} from "./protection-recovery-evidence";

/**
 * Explicit, operator-initiated recovery for a protection intervention that the
 * worker will never retry on its own.
 *
 * `TAKE_PROFIT_TRIGGER_INVALID` is deliberately outside
 * `RECOVERABLE_INTERVENTION_REASON_CODES`: price moving past the target does
 * not un-move, so an unattended retry loop would accomplish nothing. But the
 * STOP is usually placeable the whole time, and a parked position with live
 * exposure and no stop is not something to leave sitting. This is the path a
 * human takes after looking.
 *
 * ## Shape
 *
 *   evaluate  READ-ONLY. Gathers evidence and judges it. Cannot place an order:
 *             it holds `BinanceReadOnlyService` and nothing else.
 *   recover   Re-gathers that evidence itself, then hands the execution to the
 *             EXISTING protection lifecycle. It contains no placement logic of
 *             its own — `attemptProtectionRecovery` runs its own gates again
 *             and `ensureProtectionForExposure` does the work.
 */

export const PROTECTION_RECOVERY_OUTCOMES = [
  /** The lifecycle was re-entered and reported its own result. */
  "RECOVERY_ATTEMPTED",
  /** Evidence refused it. Nothing was written and nothing was submitted. */
  "BLOCKED",
  /** Not a candidate — wrong status, wrong reason, or no such execution. */
  "NOT_APPLICABLE",
  /**
   * The execution belongs to a different profile than this process is bound
   * to. A refusal, never a skip: installing another account's protection with
   * this account's credentials is the exact outcome this code exists to
   * prevent.
   */
  "FOREIGN_PROFILE",
] as const;

export type ProtectionRecoveryOutcome = (typeof PROTECTION_RECOVERY_OUTCOMES)[number];

export interface ProtectionRecoveryResult {
  ok: boolean;
  outcome: ProtectionRecoveryOutcome;
  executionId: string;
  message: string;
  checks: string[];
  blockers: string[];
  /** Execution status AFTER the attempt, so the operator sees where it landed. */
  status: string | null;
  /** Protection state AFTER the attempt. */
  protectionState: string | null;
  /** Protection reason AFTER the attempt. */
  protectionReasonCode: string | null;
}

/** Persisted order states that mean "we do not yet know what the exchange did". */
const AMBIGUOUS_ORDER_STATUSES = ["SUBMITTING", "UNKNOWN", "PLANNED"];

/** Algo states that count as live coverage. */
const ACTIVE_ALGO_STATUSES = ["NEW", "WORKING", "ACTIVE"];

export class ProtectionRecoveryService {
  /**
   * Bound to ONE profile, and unable to be built without one.
   *
   * `recover` hands the execution to the protection lifecycle, which submits
   * STOP and TAKE_PROFIT orders with this process's credentials. The
   * executionId comes from an operator's terminal, so the row's ownership is
   * checked here against something supplied at construction rather than by
   * the caller.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly readOnly: BinanceReadOnlyService,
    /**
     * The bound profile, IMMUTABLE and authoritative for the life of this
     * service. It carries the environment too, which used to be rediscovered
     * from the execution's profile row on every gather -- a second source of
     * truth that could, if that row changed underneath a running process,
     * silently move the environment judgement to a different account's.
     */
    private readonly boundProfile: BoundExecutionProfileProjection
  ) {}

  /**
   * READ-ONLY. Returns null when the execution is not a candidate at all,
   * otherwise the verdict plus the evidence behind it.
   *
   * Nothing here writes, and the only exchange capability this class holds is
   * the read-only client — it is structurally incapable of placing an order.
   */
  async evaluate(
    executionId: string
  ): Promise<{ verdict: ProtectionRecoveryVerdict; evidence: ProtectionRecoveryEvidence } | null> {
    const execution = await this.loadOwnedExecution(executionId);
    if (!execution) return null;
    // SECONDARY guard. The query above cannot return a foreign row, so this
    // can only fire if something bypassed it; it still runs BEFORE `gather`,
    // which is the first thing that reads the exchange.
    if (!this.belongsToBoundProfile(execution)) return null;

    const evidence = await this.gather(execution);
    return { verdict: judgeProtectionRecovery(evidence), evidence };
  }

  /**
   * Re-enters the protection lifecycle for ONE execution, under an explicit
   * operator authorization naming the exact intervention reason.
   *
   * The evidence is gathered again here rather than carried in from a previous
   * `evaluate`: the exchange may have moved since, and a preview is not a fact.
   */
  async recover(
    executionId: string,
    protection: ProtectionLifecycleService,
    evaluatedAt: Date = new Date()
  ): Promise<ProtectionRecoveryResult> {
    const execution = await this.loadOwnedExecution(executionId);
    if (!execution) {
      // The row was not selected, so nothing about it is known here. Which
      // refusal to print is decided by a COUNT -- no row, no fields, nothing
      // that could be carried onward into evidence gathering.
      return (await this.existsUnderAnyProfile(executionId))
        ? this.result(
            false,
            "FOREIGN_PROFILE",
            executionId,
            "The execution belongs to a different execution profile than this process is bound to; nothing was read from the exchange and nothing was changed.",
            [],
            ["execution belongs to another execution profile"],
            null,
            null,
            null
          )
        : this.result(false, "NOT_APPLICABLE", executionId, "No such execution.", [], [], null, null, null);
    }
    // SECONDARY guard, kept deliberately: the DB predicate is the primary
    // one, so reaching this branch means the query was defeated. Said out
    // loud, with ids only -- never an account alias or a credential.
    // one, and a row that reached here mismatched means something bypassed it.
    if (!this.belongsToBoundProfile(execution)) {
      logger.error(
        { executionId, boundExecutionProfileId: this.boundProfile.executionProfileId },
        "Protection recovery refused an execution that bypassed its profile-scoped query"
      );
      return this.result(
        false,
        "FOREIGN_PROFILE",
        executionId,
        "The execution belongs to a different execution profile than this process is bound to; nothing was read from the exchange and nothing was changed.",
        [],
        ["execution belongs to another execution profile (it bypassed the scoped query)"],
        null,
        null,
        null
      );
    }

    const evidence = await this.gather(execution);
    const verdict = judgeProtectionRecovery(evidence);

    logger.info(
      { executionId, symbol: execution.symbol, verdict: summarizeProtectionRecovery(verdict) },
      "Protection recovery evidence evaluated"
    );

    if (!verdict.safe) {
      const current = await this.loadStates(executionId);
      return this.result(
        false,
        "BLOCKED",
        executionId,
        `Recovery refused: ${verdict.reasonCode}. Nothing was submitted and nothing was changed.`,
        verdict.checks,
        verdict.blockers,
        current.status,
        current.protectionState,
        current.protectionReasonCode
      );
    }

    // Hand over to the EXISTING lifecycle. It re-runs its own gates — position
    // open, every leg readable, coverage not excessive, bounded budget — and
    // then `ensureProtectionForExposure` decides what, if anything, to submit.
    // No placement logic is duplicated here, and nothing forces a status.
    const outcome = await protection.attemptProtectionRecovery({
      executionId,
      expectedVersion: execution.version,
      evaluatedAt,
      operatorApproval: { reasonCode: RECOVERABLE_PROTECTION_REASON },
    });

    const after = await this.loadStates(executionId);
    return this.result(
      outcome.ok,
      "RECOVERY_ATTEMPTED",
      executionId,
      outcome.message,
      verdict.checks,
      outcome.ok ? [] : [`${outcome.reasonCode}: ${outcome.message}`],
      after.status,
      after.protectionState,
      after.protectionReasonCode
    );
  }

  // -------------------------------------------------------------------------
  // Evidence gathering. Each fact is read independently so one failure cannot
  // masquerade as a clean answer for the others.
  // -------------------------------------------------------------------------

  private async gather(execution: TradeExecution): Promise<ProtectionRecoveryEvidence> {
    const direction = execution.direction as DirectionName;
    const positionSide = protectionPositionSide(direction);

    const protectionRow = await this.prisma.executionProtectionState.findUnique({
      where: { tradeExecutionId: execution.id },
    });
    const orders = await this.prisma.binanceOrder.findMany({
      where: { tradeExecutionId: execution.id, role: { in: ["STOP_LOSS", "TAKE_PROFIT"] } },
    });

    const position = await this.fact(async () => {
      const found = await this.readOnly.getPositionForSide(execution.symbol, positionSide);
      if (!found) return "0";
      const normalized = normalizeOpenQuantity(found.positionAmt ?? "", direction);
      // A sign that contradicts the direction is a contradiction, not a zero.
      if (!normalized.valid) throw new Error("position sign contradicts the execution direction");
      return normalized.quantity;
    });

    const algo = await this.fact(async () => this.readOnly.getOpenAlgoOrders(execution.symbol));

    const stopCoverage = this.coverageFor(algo, orders, "STOP_LOSS");
    const takeProfitCoverage = this.coverageFor(algo, orders, "TAKE_PROFIT");

    const stopTrigger = execution.executableStopLoss.toString();
    const placeable = await this.fact(async () => {
      const inspection = await this.readOnly.inspectSymbol(execution.symbol);
      const mark = await this.readOnly.getMarkPrice(execution.symbol);
      const quantity = position.value ?? execution.plannedQuantity.toString();
      const verdict = validateProtectionTriggers({
        direction,
        stopTriggerPrice: stopTrigger,
        // Judged on its OWN leg. Whether the take profit is placeable is not
        // part of whether the stop is — that coupling is the defect the parent
        // commit removed, and re-introducing it here would defeat the purpose.
        takeProfitTriggerPrice: null,
        workingPrice: mark.markPrice,
        tickSize: inspection.filters.tickSize,
        stepSize: inspection.filters.stepSize,
        minQty: inspection.filters.minQty,
        quantity,
      });
      return verdict.stop.valid;
    });

    return {
      executionStatus: gathered(execution.status),
      requiresManualIntervention: gathered(execution.requiresManualIntervention),
      protectionState: protectionRow ? gathered(protectionRow.state) : unavailable("no protection row exists"),
      protectionReasonCode: protectionRow?.reasonCode
        ? gathered(protectionRow.reasonCode)
        : unavailable("the protection row carries no reason code"),
      // The BOUND environment, never a fresh read of the execution's profile
      // row. A row edited after this process bound its runtime must not be
      // able to move this judgement to another account's environment.
      environmentMatches: gathered(
        connectorEnvironmentMatches(this.boundProfile.environment, env.BINANCE_FUTURES_REST_BASE_URL)
      ),
      positionQuantity: position,
      recordedFillQuantity: execution.filledQuantity
        ? gathered(execution.filledQuantity.toString())
        : unavailable("the execution records no filled quantity"),
      activeStopQuantity: stopCoverage,
      activeTakeProfitQuantity: takeProfitCoverage,
      ambiguousProtectionSubmission: gathered(
        orders.some((order) => AMBIGUOUS_ORDER_STATUSES.includes(order.status))
      ),
      frozenStopTrigger: gathered(stopTrigger),
      stopTriggerPlaceable: placeable,
    };
  }

  /**
   * Quantity proven ACTIVE on the exchange for one role.
   *
   * Matched by the deterministic `clientAlgoId` we minted, so an order somebody
   * else placed on the same symbol is never counted as our coverage. When the
   * algo read itself failed the whole fact is unavailable rather than zero —
   * "we could not look" must not read as "there is no stop".
   */
  private coverageFor(
    algo: EvidenceFact<Awaited<ReturnType<BinanceReadOnlyService["getOpenAlgoOrders"]>>>,
    orders: { role: string; clientAlgoId: string | null }[],
    role: "STOP_LOSS" | "TAKE_PROFIT"
  ): EvidenceFact<string> {
    if (algo.status !== "OK" || algo.value === null) {
      return unavailable(algo.detail ?? "open algo orders could not be read");
    }
    const ours = new Set(
      orders.filter((order) => order.role === role && order.clientAlgoId).map((order) => order.clientAlgoId as string)
    );
    let total = 0;
    for (const entry of algo.value) {
      if (!entry.clientAlgoId || !ours.has(entry.clientAlgoId)) continue;
      if (!ACTIVE_ALGO_STATUSES.includes((entry.algoStatus ?? "").toUpperCase())) continue;
      const quantity = Number(entry.quantity ?? "");
      if (!Number.isFinite(quantity)) return unavailable(`an active ${role} reported an unreadable quantity`);
      total += quantity;
    }
    return gathered(String(total));
  }

  /** Runs one read and turns any failure into an UNAVAILABLE fact. */
  private async fact<T>(read: () => Promise<T>): Promise<EvidenceFact<T>> {
    try {
      return gathered(await read());
    } catch (error) {
      // Sanitized: the message only, never a stack carrying request material.
      return unavailable(error instanceof Error ? error.message.slice(0, 200) : "unreadable");
    }
  }

  private async loadStates(executionId: string) {
    const execution = await this.prisma.tradeExecution.findFirst({
      where: { id: executionId, executionProfileId: this.boundProfile.executionProfileId },
      select: { status: true },
    });
    const protection = await this.prisma.executionProtectionState.findUnique({
      where: { tradeExecutionId: executionId },
      select: { state: true, reasonCode: true },
    });
    return {
      status: execution?.status ?? null,
      protectionState: protection?.state ?? null,
      protectionReasonCode: protection?.reasonCode ?? null,
    };
  }

  /**
   * THE load-bearing read: an execution is selected by id AND by the bound
   * profile, in one predicate, at the database boundary.
   *
   * A row-addressed read followed by a JavaScript ownership check is not the
   * same thing. It brings another account's execution into this process, and
   * `recover` hands its argument to a lifecycle that SUBMITS stop and take
   * profit orders. Not selecting it at all removes that possibility rather
   * than guarding against it.
   */
  private async loadOwnedExecution(executionId: string): Promise<TradeExecution | null> {
    return this.prisma.tradeExecution.findFirst({
      where: { id: executionId, executionProfileId: this.boundProfile.executionProfileId },
    });
  }

  /**
   * EXISTENCE ONLY, and deliberately a count rather than a row.
   *
   * It exists so an operator who names another profile's execution is told
   * that, instead of being told the row does not exist during an incident.
   * It returns a number: there is no object to pass to `gather`, no field to
   * print, and no path from here into signed logic.
   */
  private async existsUnderAnyProfile(executionId: string): Promise<boolean> {
    return (await this.prisma.tradeExecution.count({ where: { id: executionId } })) > 0;
  }

  /**
   * The profile this service is bound to, for callers that need to EXPLAIN
   * a refusal rather than re-derive it.
   *
   * Exposing the id is not a selector: it is read-only, it is the value
   * supplied at construction, and no method accepts one.
   */
  get boundExecutionProfileId(): string {
    return this.boundProfile.executionProfileId;
  }

  /**
   * Whether a loaded row belongs to the profile this process is bound to.
   *
   * Persisted ids only: no account number is invented and no credential is
   * consulted.
   */
  private belongsToBoundProfile(execution: TradeExecution): boolean {
    return execution.executionProfileId === this.boundProfile.executionProfileId;
  }

  private result(
    ok: boolean,
    outcome: ProtectionRecoveryOutcome,
    executionId: string,
    message: string,
    checks: string[],
    blockers: string[],
    status: string | null,
    protectionState: string | null,
    protectionReasonCode: string | null
  ): ProtectionRecoveryResult {
    return { ok, outcome, executionId, message, checks, blockers, status, protectionState, protectionReasonCode };
  }
}

/**
 * Compile-time parameter contracts.
 *
 * Asserted in typechecked SOURCE rather than in a test, because the backend
 * tsconfig excludes `tests` -- a contract pinned only in a test file would
 * never be seen by `tsc`. Making the profile OPTIONAL, or dropping it, stops
 * these tuples matching and fails the build.
 */
type ExactTuple<A extends readonly unknown[], B extends readonly unknown[]> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

const protectionRecoveryRequiresAProfile: ExactTuple<
  ConstructorParameters<typeof ProtectionRecoveryService>,
  [PrismaClient, BinanceReadOnlyService, BoundExecutionProfileProjection]
> = true;
void protectionRecoveryRequiresAProfile;
