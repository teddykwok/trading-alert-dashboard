import type { PrismaClient, TradeExecution } from "@prisma/client";

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
  constructor(
    private readonly prisma: PrismaClient,
    private readonly readOnly: BinanceReadOnlyService
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
    const execution = await this.prisma.tradeExecution.findUnique({ where: { id: executionId } });
    if (!execution) return null;

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
    const execution = await this.prisma.tradeExecution.findUnique({ where: { id: executionId } });
    if (!execution) {
      return this.result(false, "NOT_APPLICABLE", executionId, "No such execution.", [], [], null, null, null);
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

    const profile = await this.prisma.executionProfile.findUnique({
      where: { id: execution.executionProfileId },
      select: { environment: true },
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
      environmentMatches: profile
        ? gathered(connectorEnvironmentMatches(profile.environment, env.BINANCE_FUTURES_REST_BASE_URL))
        : unavailable("the execution profile could not be read"),
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
    const execution = await this.prisma.tradeExecution.findUnique({
      where: { id: executionId },
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
