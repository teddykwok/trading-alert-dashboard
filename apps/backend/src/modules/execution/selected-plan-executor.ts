import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { ExtremeRRPlanDto } from "@trading-alert-dashboard/shared";
import { logger } from "../../config/logger";
import type { BinanceMarginPlanService } from "../binance/binance-margin-plan.service";
import { isExactAuthorization } from "./canary-authorization.service";
import type { ExecutionService } from "./execution.service";
import type { ExecutionOrchestrator } from "./execution-orchestrator";
import { resolveExecutionProfile, type ProfileIdentity } from "./execution-profile.service";

/**
 * Phase 11A.1 — the production link from a SELECTED Extreme RR plan to a
 * PLAN_READY TradeExecution.
 *
 * This is the one place where a trading signal becomes an execution, and it is
 * deliberately thin. It selects nothing and calculates nothing:
 *
 *  - eligibility is the PERSISTED plan state (`status === "READY"` plus a
 *    selected lookback whose candidate is valid and carries money) — there is
 *    no second selection algorithm here;
 *  - the quantity, leverage, margin and liquidation numbers come from the
 *    Phase 3 margin planner;
 *  - creation, validation and freezing come from ExecutionService;
 *  - admission comes from the orchestrator, which uses Phase 5.
 *
 * ## Idempotency
 *
 * `TradeExecution` carries `@@unique([alertId, executionProfileId])`. That
 * database constraint — not an in-memory flag — is what guarantees one logical
 * signal produces at most one execution, however many times BullMQ redelivers
 * the job or however many workers race for it. A losing writer gets P2002 and
 * simply adopts the winner's row.
 *
 * ## Crash safety
 *
 * Creation and admission are separate steps on purpose. If the process dies
 * between them, the PLAN_READY row is already durable and the orchestrator's
 * reconciliation/startup recovery picks it up — the original job delivery is
 * never required to finish for the execution to survive.
 */

export type SelectedPlanOutcome =
  | { handled: true; executionId: string; created: boolean; admitted: boolean; reasonCode: string | null }
  | { handled: false; reasonCode: SelectedPlanSkipReason; message: string };

export type SelectedPlanSkipReason =
  | "PLAN_NOT_READY"
  | "NO_SELECTED_CANDIDATE"
  | "CANDIDATE_INCOMPLETE"
  | "MARGIN_PLAN_NOT_READY"
  | "PROFILE_UNAVAILABLE"
  | "CANARY_AUTHORIZATION_REQUIRED"
  | "CANARY_AUTHORIZATION_WRONG_SYMBOL"
  | "CANARY_AUTHORIZATION_WRONG_DIRECTION"
  | "CANARY_AUTHORIZATION_ALREADY_CONSUMED";

export interface SelectedPlanExecutorDependencies {
  prisma: PrismaClient;
  marginPlanner: BinanceMarginPlanService;
  executions: ExecutionService;
  orchestrator: ExecutionOrchestrator;
  profileIdentity?: ProfileIdentity;
}

export class SelectedPlanExecutor {
  /** Set when this signal matched a prepared canary authorization. */
  private boundAuthorizationId: string | null = null;

  constructor(private readonly deps: SelectedPlanExecutorDependencies) {}

  /**
   * Turns one authoritative selected plan into (at most) one execution, then
   * hands it to admission.
   *
   * Every early return is a fail-closed skip: an incomplete plan, an invalid
   * selected candidate or a missing profile all produce nothing rather than a
   * guess.
   */
  async handleSelectedPlan(plan: ExtremeRRPlanDto, symbol: string): Promise<SelectedPlanOutcome> {
    // --- Eligibility, from the persisted plan only -------------------------
    if (plan.status !== "READY") {
      return { handled: false, reasonCode: "PLAN_NOT_READY", message: `Plan is ${plan.status}.` };
    }

    // ONLY the persisted selected lookback. A different candidate being valid
    // is irrelevant — it is not the one the plan selected.
    const candidate = plan.candidates.find((entry) => entry.requestedCandles === plan.selectedLookback);
    if (!candidate) {
      return {
        handled: false,
        reasonCode: "NO_SELECTED_CANDIDATE",
        message: `No candidate exists for the selected lookback ${plan.selectedLookback}.`,
      };
    }
    if (!plan.template) {
      return {
        handled: false,
        reasonCode: "CANDIDATE_INCOMPLETE",
        message: "The plan carries no frozen risk-template snapshot, so it has no risk budget.",
      };
    }
    if (!candidate.valid || !candidate.money || !candidate.stopLoss || !candidate.takeProfit) {
      return {
        handled: false,
        reasonCode: "CANDIDATE_INCOMPLETE",
        message: "The selected candidate is not a complete, valid, money-carrying plan.",
      };
    }

    const profile = await resolveExecutionProfile(this.deps.prisma, this.deps.profileIdentity);
    if (!profile.ok) {
      return { handled: false, reasonCode: "PROFILE_UNAVAILABLE", message: profile.message };
    }

    // --- Canary authorization (fail closed) --------------------------------
    // While ANY authorization has been prepared for this profile, the profile
    // is in canary mode and only the one specifically authorized signal may
    // proceed. That closes the activation-window race: an unrelated alert, or
    // the right symbol in the wrong direction, cannot consume the slot simply
    // because the gates happen to be open.
    //
    // The check is on the durable binding written at ingestion, never on a
    // token — nothing reusable is persisted or passed around.
    const canaryMode = await this.deps.prisma.executionCanaryAuthorization.count({
      where: { executionProfileId: profile.profile.id },
    });
    if (canaryMode > 0) {
      const bound = await this.deps.prisma.executionCanaryAuthorization.findFirst({
        where: {
          executionProfileId: profile.profile.id,
          consumedAlertId: plan.alertId,
          revokedAt: null,
        },
      });
      if (!bound) {
        return {
          handled: false,
          reasonCode: "CANARY_AUTHORIZATION_REQUIRED",
          message: "This profile is in canary mode and this signal carries no valid authorization.",
        };
      }
      // The binding must be a usable EXACT_SIGNAL row before its identity can
      // mean anything. Since Phase 12.1 the symbol and direction columns are
      // nullable — so `bound.allowedSymbol !== symbol` would compare against a
      // null and report a symbol mismatch, describing a corrupt row as a
      // merely-wrong one. A row that cannot prove what it authorizes is
      // treated as no authorization at all, which is the existing reason code.
      //
      // Nothing creates a NATURAL_WINDOW yet, and this check is NOT the
      // natural-window path: it is the exact path refusing everything that is
      // not exact.
      if (!isExactAuthorization(bound)) {
        return {
          handled: false,
          reasonCode: "CANARY_AUTHORIZATION_REQUIRED",
          message: "The bound authorization is not a usable exact-signal authorization.",
        };
      }
      // Identity is re-asserted here too: the binding proves WHICH alert, and
      // these prove the alert still matches what was authorized.
      if (bound.allowedSymbol !== symbol.trim().toUpperCase()) {
        return {
          handled: false,
          reasonCode: "CANARY_AUTHORIZATION_WRONG_SYMBOL",
          message: `The authorization admits ${bound.allowedSymbol}, not this symbol.`,
        };
      }
      if (bound.allowedDirection !== plan.direction) {
        return {
          handled: false,
          reasonCode: "CANARY_AUTHORIZATION_WRONG_DIRECTION",
          message: `The authorization admits ${bound.allowedDirection}, not ${plan.direction}.`,
        };
      }
      // Bound to a DIFFERENT execution already: that execution may still
      // recover, but this one may never adopt the authorization.
      if (bound.consumedExecutionId !== null) {
        const owner = await this.deps.prisma.tradeExecution.findUnique({
          where: { id: bound.consumedExecutionId },
          select: { alertId: true },
        });
        if (owner && owner.alertId !== plan.alertId) {
          return {
            handled: false,
            reasonCode: "CANARY_AUTHORIZATION_ALREADY_CONSUMED",
            message: "The authorization is already bound to a different execution.",
          };
        }
      }
      this.boundAuthorizationId = bound.id;
    }

    // --- Phase 3 does the mathematics -------------------------------------
    // The snapshot-aware call returns the exact filters the calculation used,
    // from the SAME symbol inspection. Phase 6 revalidation requires them to be
    // frozen on the execution, and asking Binance a second time could freeze
    // filters that describe a different calculation.
    const { plan: marginPlan, exchangeFilters } = await this.deps.marginPlanner.planForSymbolWithSnapshot({
      symbol,
      direction: plan.direction,
      entryPrice: plan.entryPrice,
      stopLoss: candidate.stopLoss,
      // The frozen template snapshot is the authoritative risk budget.
      riskBudgetUsd: plan.template.riskAmount,
    });
    if (marginPlan.status !== "READY" || marginPlan.selectedLeverage === null) {
      return {
        handled: false,
        reasonCode: "MARGIN_PLAN_NOT_READY",
        message: `The margin plan is ${marginPlan.status}${marginPlan.reason ? `/${marginPlan.reason}` : ""}.`,
      };
    }

    // --- Creation (idempotent through the database) ------------------------
    let executionId: string;
    let created = false;
    try {
      const execution = await this.deps.executions.createExecutionFromReadyPlan({
        executionProfileId: profile.profile.id,
        alertId: plan.alertId,
        extremeRRPlanId: plan.id,
        plan: marginPlan,
        takeProfit: candidate.takeProfit,
        selectedLookback: plan.selectedLookback,
        // The profile is created disabled by bootstrap and is only enabled in
        // an authorized window; planning ahead of that is safe because the
        // KILL SWITCH and the live gates still block every mutation.
        allowDisabledProfile: true,
        snapshots: { extremeRRCandidate: candidate, marginPlan, exchangeFilters },
      });
      executionId = execution.id;
      created = true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // A concurrent worker or a redelivered job won the unique race. Adopt
        // its row rather than creating a second one.
        const existing = await this.deps.prisma.tradeExecution.findFirst({
          where: { alertId: plan.alertId, executionProfileId: profile.profile.id },
        });
        if (!existing) throw error;
        executionId = existing.id;
      } else {
        throw error;
      }
    }

    // Record which execution this authorization produced, so a later signal
    // can never adopt it while THIS execution stays recoverable.
    if (this.boundAuthorizationId) {
      await this.deps.prisma.executionCanaryAuthorization.updateMany({
        where: { id: this.boundAuthorizationId, consumedExecutionId: null },
        data: { consumedExecutionId: executionId },
      });
    }

    // --- Admission (separable; recoverable if this never runs) -------------
    const admission = await this.deps.orchestrator.admitAndSubmit({ executionId });

    // `admitted` means safety admission PASSED, not that an entry was reserved:
    // a PREFLIGHT execution whose revalidation refuses still reports
    // admitted=true with a failure reasonCode and no timeline event. Naming the
    // reason code explicitly keeps that distinction readable in the log — the
    // missing exchange-filters snapshot looked exactly like a success here.
    logger.info(
      {
        executionId,
        created,
        admitted: admission.admitted,
        reasonCode: admission.reasonCode,
        entryReserved: admission.admitted && admission.reasonCode === "ENTRY_SUBMITTED",
      },
      "Selected Extreme RR plan handled"
    );

    return {
      handled: true,
      executionId,
      created,
      admitted: admission.admitted,
      reasonCode: admission.reasonCode ?? null,
    };
  }
}
