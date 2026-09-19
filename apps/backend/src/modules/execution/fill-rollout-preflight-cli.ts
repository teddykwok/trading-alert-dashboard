import type { PrismaClient } from "@prisma/client";

import {
  bindConfiguredExecutionProfileEnvironment,
  type BinanceProfileBindingFailure,
  type BinanceProfileBindingResult,
} from "./binance-profile-binding";

/**
 * The operator boundary that answers ONE question, before anything is armed:
 *
 *   "If I restart the worker now, what exactly will the historical runtime do?"
 *
 * ## Why this exists
 *
 * `env` is parsed once, at process start. Editing `.env` cannot change a worker
 * that is already running, so arming the scheduler means writing a file and
 * restarting -- and until that restart there is no way to see what the new
 * process will believe. Worse, the ingest horizon DEFAULTS TO 30 DAYS when the
 * key is absent, and the root bootstrap runs BEFORE any weight or campaign
 * admission, so the request caps do not bound root materialization at all. An
 * operator who meant three days and forgot the key gets ten times the workset
 * and no warning.
 *
 * This command is the missing look-before-the-restart. It is read-only in the
 * strongest sense available: it holds no service that can write, issues no
 * exchange request, and starts nothing.
 *
 * ## Why an explicit 30 and a defaulted 30 are different answers
 *
 * They parse to the same number and mean entirely different things: one is a
 * decision, the other is a gap. The parsed value can never tell them apart, so
 * explicitness is read from RAW KEY PRESENCE instead -- see `horizonSource`.
 *
 * ## What READY does and does not mean
 *
 * READY means the configuration and the durable preconditions are coherent with
 * each other. It performs no work, reserves nothing, and promises nothing about
 * what the exchange will return. BLOCKED means: do not restart the worker yet.
 */

export const PREFLIGHT_CLI_EXIT = { READY: 0, BLOCKED: 1, USAGE: 2 } as const;

export const PREFLIGHT_USAGE = [
  "Usage:",
  "  pnpm execution:fill-rollout-preflight",
  "",
  "Takes NO arguments. Acts on the configured, environment-bound execution",
  "profile; no profile, account, horizon, weight-cap or campaign flag exists.",
  "",
  "Read-only: it reports the effective historical rollout configuration and the",
  "durable preconditions, and derives theoretical bounds. It writes nothing,",
  "contacts no exchange, and starts nothing.",
  "",
  "Run it in a FRESH process after writing the intended .env values and BEFORE",
  "restarting the worker. Exit 0 (READY) means the configuration is coherent;",
  "any other exit means do not restart the worker.",
].join("\n");

export interface PreflightCliResult {
  exitCode: (typeof PREFLIGHT_CLI_EXIT)[keyof typeof PREFLIGHT_CLI_EXIT];
}

/** Why a rollout is refused. Ordered as the report prints them. */
export type PreflightBlocker =
  | "PROFILE_UNAVAILABLE"
  | "RUNTIME_DISABLED"
  | "HORIZON_DEFAULTED"
  | "SHARED_WEIGHT_CAP_MISSING"
  | "NO_ACTIVE_CAMPAIGN"
  | "CAMPAIGN_BUDGET_EXHAUSTED"
  | "CIRCUIT_OPEN"
  | "ATTEMPT_EXHAUSTED_WINDOWS_PRESENT";

/** Where the ingest horizon actually came from. NEVER inferred from its value. */
export type HorizonSource = "EXPLICIT" | "DEFAULT";

/** The effective configuration this process would hand a runtime. */
export interface PreflightConfig {
  runtimeEnabled: boolean;
  horizonDays: number;
  horizonSource: HorizonSource;
  intervalSeconds: number;
  maxWindowsPerTick: number;
  maxUserTradesWeightPerTick: number;
  /** Undefined is the ordinary state while the runtime is off. */
  sharedUserTradesWeightPerMinute: number | undefined;
  /** What one userTrades call costs. A domain constant, not a knob. */
  userTradesWeightPerRequest: number;
}

/** The durable facts, read once. Every field comes from a SELECT. */
export interface PreflightState {
  symbolUniverseCount: number;
  campaignStatus: string | null;
  campaignMaxDispatches: number | null;
  campaignDispatchesUsed: number | null;
  circuitState: string;
  attemptExhaustedCount: number;
}

export interface PreflightCliDependencies {
  config: PreflightConfig;
  /** ONE read-only query bundle. It is handed no service that can write. */
  readState: (executionProfileId: string) => Promise<PreflightState>;
  prisma: PrismaClient;
  bindProfile?: (prisma: PrismaClient) => Promise<BinanceProfileBindingResult>;
  out?: (line: string) => void;
}

/** The derived bounds. Every one is a CEILING, never a prediction. */
export interface PreflightProjection {
  /**
   * The workset the bootstrap would CONSIDER, not a promise of rows created.
   * Roots that already exist are skipped, so the number actually written is
   * this minus whatever is already present.
   */
  rootUpperBound: number;
  campaignDispatchesRemaining: number | null;
  /** Null when no shared cap is configured, because the runtime could not start. */
  requestsPerFreshCapTick: number | null;
  requestsPerUtcMinute: number | null;
}

export function projectRollout(
  config: PreflightConfig,
  state: PreflightState
): PreflightProjection {
  const weight = config.userTradesWeightPerRequest;
  const remaining =
    state.campaignMaxDispatches === null || state.campaignDispatchesUsed === null
      ? null
      : Math.max(0, state.campaignMaxDispatches - state.campaignDispatchesUsed);

  const cap = config.sharedUserTradesWeightPerMinute;
  const requestsPerUtcMinute = cap === undefined ? null : Math.floor(cap / weight);

  // EVERY restrictive factor, not just the loop bound. A tick is limited by the
  // smallest of them, and reporting only `maxWindows` would overstate the
  // exposure of a correctly-capped rollout by a wide margin.
  const factors = [
    config.maxWindowsPerTick,
    Math.floor(config.maxUserTradesWeightPerTick / weight),
    requestsPerUtcMinute,
    remaining,
  ].filter((value): value is number => value !== null);

  return {
    rootUpperBound: state.symbolUniverseCount * config.horizonDays,
    campaignDispatchesRemaining: remaining,
    requestsPerFreshCapTick: cap === undefined ? null : Math.min(...factors),
    requestsPerUtcMinute,
  };
}

/**
 * Every reason this rollout is not ready, in report order.
 *
 * Returns an empty list for READY. Each entry is a condition an operator must
 * change deliberately; nothing here fixes anything.
 */
export function blockersFor(config: PreflightConfig, state: PreflightState): PreflightBlocker[] {
  const blockers: PreflightBlocker[] = [];

  if (!config.runtimeEnabled) blockers.push("RUNTIME_DISABLED");
  // A DEFAULTED horizon is refused even when its value is the one intended:
  // the point is that nobody chose it, and the bootstrap runs before any
  // request cap can bound what it materializes.
  if (config.horizonSource !== "EXPLICIT") blockers.push("HORIZON_DEFAULTED");
  if (config.sharedUserTradesWeightPerMinute === undefined) {
    blockers.push("SHARED_WEIGHT_CAP_MISSING");
  }
  if (state.campaignStatus !== "ACTIVE") blockers.push("NO_ACTIVE_CAMPAIGN");
  else if (
    state.campaignMaxDispatches !== null &&
    state.campaignDispatchesUsed !== null &&
    state.campaignDispatchesUsed >= state.campaignMaxDispatches
  ) {
    blockers.push("CAMPAIGN_BUDGET_EXHAUSTED");
  }
  if (state.circuitState !== "CLOSED") blockers.push("CIRCUIT_OPEN");
  // An unclaimable window keeps the queue non-empty forever, so a campaign
  // started over it can never be observed as drained.
  if (state.attemptExhaustedCount > 0) blockers.push("ATTEMPT_EXHAUSTED_WINDOWS_PRESENT");

  return blockers;
}

function line(out: (line: string) => void, label: string, value: unknown): void {
  out(`  ${label.padEnd(32)} ${value === null || value === undefined ? "—" : String(value)}`);
}

export async function runFillRolloutPreflightCli(
  argv: string[],
  deps: PreflightCliDependencies
): Promise<PreflightCliResult> {
  const out = deps.out ?? ((text: string) => console.log(text));

  if (argv.length > 0) {
    out(PREFLIGHT_USAGE);
    return { exitCode: PREFLIGHT_CLI_EXIT.USAGE };
  }

  const bindProfile = deps.bindProfile ?? bindConfiguredExecutionProfileEnvironment;
  const binding = await bindProfile(deps.prisma);
  if (!binding.ok) {
    out("historical rollout preflight");
    line(out, "outcome", "BLOCKED");
    line(out, "blocker", "PROFILE_UNAVAILABLE" satisfies PreflightBlocker);
    line(out, "reason", binding.reasonCode satisfies BinanceProfileBindingFailure);
    return { exitCode: PREFLIGHT_CLI_EXIT.BLOCKED };
  }

  const config = deps.config;
  const state = await deps.readState(binding.context.executionProfileId);
  const projection = projectRollout(config, state);
  const blockers = blockersFor(config, state);
  const ready = blockers.length === 0;

  out("historical rollout preflight");
  line(out, "outcome", ready ? "READY" : "BLOCKED");
  line(out, "runtime enabled", config.runtimeEnabled);
  line(out, "ingest horizon days", config.horizonDays);
  line(out, "horizon source", config.horizonSource);
  line(out, "scheduler interval seconds", config.intervalSeconds);
  line(out, "max windows per tick", config.maxWindowsPerTick);
  line(out, "max userTrades weight per tick", config.maxUserTradesWeightPerTick);
  line(out, "shared weight per minute", config.sharedUserTradesWeightPerMinute);
  line(
    out,
    "shared cap source",
    config.sharedUserTradesWeightPerMinute === undefined ? "ABSENT" : "EXPLICIT"
  );
  line(out, "userTrades weight per request", config.userTradesWeightPerRequest);
  line(out, "symbol universe count", state.symbolUniverseCount);
  line(out, "projected root upper bound", projection.rootUpperBound);
  line(out, "projected requests per tick", projection.requestsPerFreshCapTick);
  line(out, "projected requests per minute", projection.requestsPerUtcMinute);
  line(out, "campaign status", state.campaignStatus);
  line(out, "campaign max dispatches", state.campaignMaxDispatches);
  line(out, "campaign dispatches used", state.campaignDispatchesUsed);
  line(out, "campaign dispatches remaining", projection.campaignDispatchesRemaining);
  line(out, "circuit state", state.circuitState);
  line(out, "pending attempt exhausted", state.attemptExhaustedCount);
  for (const blocker of blockers) line(out, "blocker", blocker);

  return {
    exitCode: ready ? PREFLIGHT_CLI_EXIT.READY : PREFLIGHT_CLI_EXIT.BLOCKED,
  };
}
