import { SCANNER_MARKET_TYPE, type ScannerChartInterval } from "./binance-public-futures";
import { liveShadowDir, type SelectionSummary, type SupervisorSelection } from "./live-shadow-supervisor";
import { liveShadowEngineDir, type ProfileSummary } from "./scanner-profile";
import { RunManifestError, SUPERVISOR_RUN_MANIFEST_SCHEMA, buildRunManifest, type RunManifestSymbol, type SupervisorRunManifest } from "./supervisor-run-manifest";
import { selectSymbols, universeWalk, type UniverseSelectionSpec, type UsdmUniverse } from "./usdm-universe";

/**
 * The supervisor CLI's wiring from parsed options to runtime inputs: the
 * selection, the state directory of each symbol and the run manifest. Pure (no
 * file system, network or clock), so the exact path a real run takes is the
 * path the tests take.
 */

/**
 * EXPLICIT: exactly the named symbols, never substituted. UNIVERSE: the whole
 * walk, accepting SCANNER-ELIGIBLE symbols until `maxSymbols` are accepted
 * (TARGET), or every one of them when there is no count (ALL_ACTIVE).
 */
export function supervisorSelectionOf(universe: UsdmUniverse, spec: UniverseSelectionSpec): SupervisorSelection {
  if (spec.mode === "EXPLICIT") {
    const explicit = selectSymbols(universe, spec);
    return { mode: "EXPLICIT", candidates: explicit.contracts.map((c) => ({ symbol: c.symbol, onboardDateMs: c.onboardDateMs, required: true })) };
  }
  const walk = universeWalk(universe, spec).map(({ contract, required }) => ({ symbol: contract.symbol, onboardDateMs: contract.onboardDateMs, required }));
  return spec.maxSymbols === null ? { mode: "ALL_ACTIVE", candidates: walk } : { mode: "TARGET", candidates: walk, target: spec.maxSymbols };
}

/** How many symbols the configured connections can carry. */
export const connectionCapacityOf = (symbolsPerConnection: number, maxConnections: number) => symbolsPerConnection * maxConnections;

/** A profile run keeps its state in its engine namespace; only a legacy explicit-flag run uses the legacy tree. */
export function supervisorLiveDirFor(root: string, profile: ProfileSummary | null, chartInterval: ScannerChartInterval): (symbol: string) => string {
  return profile === null
    ? (symbol) => liveShadowDir(root, symbol, chartInterval)
    : (symbol) => liveShadowEngineDir(root, profile.engineFingerprint, SCANNER_MARKET_TYPE, symbol, chartInterval);
}

const EXPLICIT_COUNTS = {
  mode: "EXPLICIT",
  universeActive: null,
  targetEligible: null,
  candidatesTested: 0,
  acceptedEligible: 0,
  skippedTooNew: 0,
  skippedInsufficientHistory: 0,
  skippedOther: 0,
  universeExhausted: true,
} as const;

/**
 * The run manifest of a started supervisor: its identity and exactly its
 * accepted running set. For a walked universe (TARGET / ALL_ACTIVE) the
 * selection's own accepted count must equal the symbols listed, so an omitted
 * symbol is a refusal, never a shorter manifest.
 */
export function supervisorRunManifestOf(input: {
  readonly runId: string;
  readonly startedAt: string;
  readonly gitHead: string;
  readonly chartInterval: ScannerChartInterval;
  readonly engineFingerprint: string;
  readonly profile: ProfileSummary | null;
  readonly selection: SelectionSummary | null;
  readonly symbols: readonly RunManifestSymbol[];
}): SupervisorRunManifest {
  const counts = input.selection ?? EXPLICIT_COUNTS;
  if (counts.mode !== "EXPLICIT" && counts.acceptedEligible !== input.symbols.length) {
    throw new RunManifestError(`the ${counts.mode} selection accepted ${counts.acceptedEligible} symbols but ${input.symbols.length} are listed`);
  }
  return buildRunManifest({
    schema: SUPERVISOR_RUN_MANIFEST_SCHEMA,
    runId: input.runId,
    startedAt: input.startedAt,
    gitHead: input.gitHead,
    marketType: SCANNER_MARKET_TYPE,
    chartInterval: input.chartInterval,
    engineFingerprint: input.engineFingerprint,
    profile: input.profile,
    stateLayout: input.profile === null ? "LEGACY" : "ENGINE_NAMESPACE",
    selection: {
      mode: counts.mode,
      universeActive: counts.universeActive,
      targetEligible: counts.targetEligible,
      candidatesTested: counts.candidatesTested,
      acceptedEligible: input.symbols.length,
      skippedTooNew: counts.skippedTooNew,
      skippedInsufficientHistory: counts.skippedInsufficientHistory,
      skippedOther: counts.skippedOther,
      universeExhausted: counts.universeExhausted,
    },
    symbols: input.symbols,
    actionable: false,
  });
}
