import { PrismaClient } from "@prisma/client";
import { env } from "../../config/env";
import { CanaryPreflightService } from "./canary-preflight.service";
import { CANARY_PINNED_LIMITS, CANARY_POLICY, effectiveCanaryLimits } from "./canary-readiness";
import { CanaryAuthorizationService, describeAuthorizationWindow } from "./canary-authorization.service";
import { describeNaturalWindow } from "./natural-authorization";
import type { CanaryAuthorizationMode } from "./canary-readiness";
import {
  currentProcessGateSnapshot,
  configuredRuntimeIdentity,
  readRuntimeAttestationStatusOnce,
} from "../runtime/runtime-attestation";
import { configuredProfileIdentity, resolveExecutionProfile } from "./execution-profile.service";

/**
 * Live-canary READ-ONLY preflight (Phase 11A).
 *
 *   pnpm --filter @trading-alert-dashboard/backend execution:canary-preflight
 *
 * Sends ZERO Binance mutations. Creates no execution row, changes no gate, and
 * cancels or closes nothing. Prints sanitized counts and configuration names
 * only — never a credential, balance, position symbol, quantity, order id or
 * signed URL.
 *
 * There is deliberately no --force, --skip-safety or --ignore-preflight flag.
 * A blocker is information, not an obstacle to route around.
 */

function line(label: string, value: string | number | boolean | null | undefined): void {
  console.log(`  ${label.padEnd(34)} ${value === null || value === undefined ? "—" : String(value)}`);
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

/** The only spellings `--mode` accepts. Case-sensitive, so there is one answer. */
const MODE_VALUES: Record<string, CanaryAuthorizationMode> = {
  exact: "EXACT_SIGNAL",
  EXACT_SIGNAL: "EXACT_SIGNAL",
  natural: "NATURAL_WINDOW",
  NATURAL_WINDOW: "NATURAL_WINDOW",
};

export type ModeResolution =
  | { ok: true; mode: CanaryAuthorizationMode }
  | { ok: false; message: string };

/**
 * Resolves `--mode`, FAIL CLOSED.
 *
 * Absent means EXACT_SIGNAL, which is the historical behaviour every existing
 * caller depends on. But an explicitly SUPPLIED value must be recognized
 * exactly: the first version of this parser matched `natural` and fell through
 * to EXACT_SIGNAL for anything else, so `--mode=natrual` printed a full,
 * confident EXACT readiness report while the operator believed they were
 * reading NATURAL readiness. On a command whose entire purpose is deciding
 * whether real money may trade, a typo must never answer a different question
 * than the one that was asked.
 *
 * A repeated `--mode` is refused rather than resolved by precedence: with
 * `--mode=natural --mode=exact` there is no defensible "winner", and guessing
 * one produces exactly the same misreading.
 */
export function resolveMode(argv: readonly string[]): ModeResolution {
  const supplied = argv.filter((entry) => entry === "--mode" || entry.startsWith("--mode="));
  if (supplied.length === 0) return { ok: true, mode: "EXACT_SIGNAL" };
  if (supplied.length > 1) {
    return { ok: false, message: `--mode was supplied ${supplied.length} times; supply it at most once.` };
  }

  const [only] = supplied;
  const value = only === "--mode" ? "" : only.slice("--mode=".length);
  const resolved = MODE_VALUES[value];
  if (resolved === undefined) {
    return {
      ok: false,
      message:
        `--mode=${value} is not a known mode. Use one of: ${Object.keys(MODE_VALUES).join(", ")}. ` +
        "Omit --mode entirely for the default (EXACT_SIGNAL).",
    };
  }
  return { ok: true, mode: resolved };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // Which authorization the canary is being judged for. Resolved BEFORE the
    // preflight runs, so a malformed flag costs no Binance read and can never
    // print a readiness verdict for a mode nobody asked about.
    const requested = resolveMode(process.argv);
    if (!requested.ok) {
      console.log(`BLOCKED — ${requested.message}`);
      console.log("Nothing was read and nothing was changed.");
      process.exitCode = 1;
      return;
    }
    const mode = requested.mode;

    // Phase 12.4D-A.1: the preflight CLI opts INTO runtime attestation, so an
    // operator can see whether the running processes match this command's own
    // configuration. It is a LIVE_ACTIVATION concern only — preparation
    // readiness is unaffected when the runtime is intentionally down.
    const service = new CanaryPreflightService(prisma, {
      probes: {
        runtimeAttestation: async () => {
          const status = await readRuntimeAttestationStatusOnce({
            identity: configuredRuntimeIdentity(),
            expected: currentProcessGateSnapshot(),
          });
          return {
            evaluated: true,
            ok: status.ok,
            reasonCode: status.reasonCode,
            message: status.message,
          };
        },
      },
    });
    const result = await service.run(mode);
    const { infrastructure, binance, local, policy, gates } = result.gathered;

    console.log("LIVE CANARY PREFLIGHT (Phase 11A) — read-only. No Binance mutation is possible from this command.");

    section("Infrastructure");
    line("databaseReady", infrastructure.databaseReady);
    line("redisReady", infrastructure.redisReady);
    line("executionWorkerReady", infrastructure.executionWorkerReady);
    line("notificationSchedulerReady", infrastructure.notificationSchedulerReady);
    line("executionOrchestrationWired", infrastructure.executionOrchestrationWired);

    section("Binance (counts only)");
    line("connected", binance.connected);
    line("signedRequestWorks", binance.signedRequestWorks);
    line("consecutiveSignedSuccesses", `${binance.consecutiveSignedSuccesses} / ${binance.requiredConsecutiveSuccesses}`);
    line("positionMode", binance.positionMode);
    line("assetMode", binance.assetMode);
    line("nonZeroPositionCount", binance.nonZeroPositionCount);
    line("openOrderCount", binance.openOrderCount);

    section("Local execution state (counts only)");
    line("activeExecutionCount", local.activeExecutionCount);
    line("pendingEntryCount", local.pendingEntryCount);
    line("openPositionCount", local.openPositionCount);
    line("recoveryRequiredCount", local.recoveryRequiredCount);

    // Every pinned limit on all three values. A correct global hiding a stale
    // profile row is exactly the failure this layout exists to make visible.
    section("Policy (global / profile row / effective / required)");
    if (policy.profile === null) {
      line("profile policy row", "UNREADABLE — effective policy cannot be proven");
    }
    // Effective comes from the SHARED merge, never recomputed here.
    const effective = policy.profile === null ? null : effectiveCanaryLimits(policy.global, policy.profile);
    for (const name of CANARY_PINNED_LIMITS) {
      console.log(`  ${name}`);
      line("    global", policy.global[name]);
      line("    profile", policy.profile ? policy.profile[name] : null);
      line("    effective", effective ? effective[name] : null);
      line("    required", CANARY_POLICY[name]);
    }

    section("Per-plan margin envelope (env only — not min-merged)");
    line("targetMarginMultiplier", env.BINANCE_TARGET_MARGIN_MULTIPLIER);
    line("maxMarginMultiplier", env.BINANCE_MAX_MARGIN_MULTIPLIER);
    // Which leverage-selection rule is live, not just the number behind it.
    line(
      "minMarginUsd",
      env.BINANCE_MIN_MARGIN_USD === "0"
        ? "0 (floor disabled — closest-to-target selection)"
        : `${env.BINANCE_MIN_MARGIN_USD} (smallest margin at or above the floor)`
    );

    // No dollar envelope is printed here, deliberately. This section knows the
    // MULTIPLIERS but not the per-plan RISK they multiply: that is
    // plan.template.riskAmount, frozen onto each Extreme RR plan from whichever
    // risk template was active when the plan was generated, and it can differ
    // between two plans that exist at the same time.
    //
    // This once multiplied maxTotalPlannedRiskUsd instead, which was only ever
    // right by coincidence: at a one-trade policy the AGGREGATE cap equalled the
    // per-trade budget. Raising the portfolio cap to 7.50 made the same line
    // report a 30.00 "per-plan" target on an activation screen. An inferred
    // figure (cap ÷ maxTotalActiveTrades, or a lookup of today's active
    // template) would be just as wrong the moment a plan froze a different
    // template, so the honest thing is to name the source and print nothing.
    line("  → per-plan dollar envelope", "plan.riskAmount × the multipliers above, resolved per plan");

    section("Safety posture");
    line("globalKillSwitch", gates.globalKillSwitch);
    line("profileKillSwitchEngaged", gates.profileKillSwitchEngaged);
    line("liveEntryEnabled", gates.liveEntryEnabled);
    line("protectionReady", gates.protectionReady);
    line("accountSetupMutations", gates.accountSetupMutationsEnabled);
    line("testOrderEnabled", gates.testOrderEnabled);
    line("autoAddMarginEnabled", gates.autoAddMarginEnabled);
    line("emergencyCloseMode", gates.emergencyCloseMode);

    // --- Phase 11B.0: the authorization window ---------------------------
    // Purely a mirror of durable state. It prints no raw authorization and no
    // hash — only whether one exists and what it would admit.
    section("Canary authorization window (Phase 11B.0)");
    const resolution = await resolveExecutionProfile(prisma, configuredProfileIdentity());
    if (!resolution.ok) {
      line("profile", `unavailable (${resolution.reasonCode})`);
    } else {
      const profile = resolution.profile;
      const authorizations = await new CanaryAuthorizationService(prisma).listForProfile(profile.id);
      // "prepared" means ACTIVE — unconsumed, unrevoked and unexpired. A row
      // merely existing is history, and history never opens a window.
      const status = describeAuthorizationWindow(authorizations);

      // Environment only — the account identifier is deliberately not printed.
      line("profile", `resolved (${profile.environment})`);
      line("profile isEnabled", profile.isEnabled);
      line("profile killSwitchActive", profile.safetyPolicy?.killSwitchActive ?? null);
      // The row's limits are reported in the Policy section above, against the
      // global and the effective merge; only its version is useful here, since
      // that is what execution:set-policy must supply to write safely.
      line("policy row version", profile.safetyPolicy?.version ?? null);
      // [] means ALLOW ALL — always worth seeing explicitly.
      const allowed = profile.safetyPolicy?.allowedSymbols ?? [];
      line("allowedSymbols", allowed.length === 0 ? "[] (ALLOW ALL)" : `[${allowed.join(", ")}]`);
      line("authorization mode judged", mode);
      const naturalRows = authorizations.filter((row) => row.authorizationType === "NATURAL_WINDOW");
      line("natural windows on record", naturalRows.length);
      if (naturalRows.length > 0) {
        const natural = describeNaturalWindow(naturalRows[0], new Date());
        line("natural state", natural.state);
        line("natural allowedDirections", `[${natural.allowedDirections.join(", ")}]`);
        line("natural maxClaims", natural.maxClaims);
        line("natural claimedCount", natural.claimedCount);
        line("natural remainingClaims", natural.remainingClaims);
        line("natural expiresAt", natural.expiresAt);
      }
      line("authorization prepared", status.prepared);
      line("active authorization count", status.activeCount);
      line("authorizations on record", status.onRecord);
      if (status.onRecord > 0) {
        // Whose fields the lines below belong to, so they are never ambiguous.
        line("shown record", status.prepared ? "the ACTIVE authorization" : "latest HISTORICAL (none active)");
        line("authorization symbol", status.symbol);
        line("authorization direction", status.direction);
        line("authorization expiresAt", status.expiresAt);
        line("authorization expired", status.expired);
        line("authorization consumed", status.consumed);
        line("authorization revoked", status.revoked);
      }
    }

    section(result.ready ? "CANARY READY" : "CANARY BLOCKED");
    line("summary", result.summary);

    if (result.preparationBlockers.length > 0) {
      console.log("");
      console.log("  PREPARATION blockers — these must be fixed before a canary is possible:");
      for (const finding of result.preparationBlockers) console.log(`    [${finding.code}] ${finding.detail}`);
    }
    if (result.liveActivationBlockers.length > 0) {
      console.log("");
      console.log("  LIVE-ACTIVATION blockers — EXPECTED during Phase 11A, cleared only inside an authorized window:");
      for (const finding of result.liveActivationBlockers) console.log(`    [${finding.code}] ${finding.detail}`);
    }

    console.log("");
    console.log(
      result.preparationReady
        ? "Preparation is complete. Live activation still requires explicit operator authorization."
        : "Preparation is NOT complete. Do not open a canary window."
    );
    console.log("Nothing was cancelled, closed or changed by this command.");

    if (!result.preparationReady) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`Canary preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
