import { SCANNER_MARKET_TYPE, assertScannerSymbol, intervalMsOf, type ScannerChartInterval } from "./binance-public-futures";
import { canonicalJson, canonicalSha256 } from "./canonical-json";
import type { ProfileSummary } from "./scanner-profile";

/**
 * A supervisor RUN MANIFEST: the immutable record of one supervisor run's
 * identity — its runId, its profile and engine fingerprint, and exactly the
 * symbols it ACCEPTED with each one's lineage.
 *
 * It is written once, after selection and before any connection opens, and
 * never rewritten. A consumer (the multi-symbol native emitter) pins itself to
 * one manifest by runId, profile and engine fingerprint, so a later, unrelated
 * run can never silently retarget it. Observational: actionable is false.
 *
 * Pure: builds and validates objects and text. No file system.
 */

export const SUPERVISOR_RUN_MANIFEST_SCHEMA = "teddy.native-scanner.supervisor-run-manifest.v1";

const SHA = /^[0-9a-f]{64}$/;
/** <UTC compact time>-<8 hex>: sortable and unique per run. */
export const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

export interface RunManifestSymbol {
  readonly symbol: string;
  readonly lineageId: string;
  /** With the engine policy, recomputes the lineage — so a consumer can verify engine -> lineage itself. */
  readonly bootstrapInputSha256: string;
}

export interface SupervisorRunManifestBody {
  readonly schema: typeof SUPERVISOR_RUN_MANIFEST_SCHEMA;
  readonly runId: string;
  readonly startedAt: string;
  readonly gitHead: string;
  readonly marketType: typeof SCANNER_MARKET_TYPE;
  readonly chartInterval: ScannerChartInterval;
  readonly engineFingerprint: string;
  /** Null for a legacy (explicit-flag) run. */
  readonly profile: ProfileSummary | null;
  /** Where the run's state lives: the engine namespace (profile) or the legacy tree. */
  readonly stateLayout: "ENGINE_NAMESPACE" | "LEGACY";
  readonly selection: {
    readonly mode: string;
    readonly universeActive: number | null;
    readonly targetEligible: number | null;
    readonly candidatesTested: number;
    readonly acceptedEligible: number;
    readonly skippedTooNew: number;
    readonly skippedInsufficientHistory: number;
    readonly skippedOther: number;
    readonly universeExhausted: boolean;
  };
  /** The accepted running set, sorted by symbol. */
  readonly symbols: readonly RunManifestSymbol[];
  readonly actionable: false;
}

export interface SupervisorRunManifest {
  readonly body: SupervisorRunManifestBody;
  readonly bodySha256: string;
}

export class RunManifestError extends Error {
  readonly code = "RUN_MANIFEST_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RunManifestError";
  }
}

const invalid = (message: string): never => {
  throw new RunManifestError(message);
};

const BODY_KEYS = [
  "schema",
  "runId",
  "startedAt",
  "gitHead",
  "marketType",
  "chartInterval",
  "engineFingerprint",
  "profile",
  "stateLayout",
  "selection",
  "symbols",
  "actionable",
].sort();

export function assertRunManifestBody(body: SupervisorRunManifestBody): void {
  if (body === null || typeof body !== "object") invalid("manifest body must be an object");
  if (canonicalJson(Object.keys(body).sort()) !== canonicalJson(BODY_KEYS)) invalid("manifest body has missing or extra fields");
  if (body.schema !== SUPERVISOR_RUN_MANIFEST_SCHEMA) invalid("unknown manifest schema");
  if ((body.actionable as unknown) !== false) invalid("a run manifest is never actionable");
  if (!RUN_ID_PATTERN.test(body.runId)) invalid("runId is malformed");
  if (body.marketType !== SCANNER_MARKET_TYPE) invalid(`marketType must be ${SCANNER_MARKET_TYPE}`);
  intervalMsOf(body.chartInterval);
  if (!SHA.test(body.engineFingerprint)) invalid("engineFingerprint must be a SHA-256 hex digest");
  if (body.stateLayout !== "ENGINE_NAMESPACE" && body.stateLayout !== "LEGACY") invalid("unknown state layout");
  if (body.profile !== null) {
    if (body.profile.engineFingerprint !== body.engineFingerprint) invalid("the profile's engine fingerprint differs from the run's");
    if (body.stateLayout !== "ENGINE_NAMESPACE") invalid("a profile run keeps its state in its engine namespace");
  }
  if (!Array.isArray(body.symbols)) invalid("symbols must be a list");
  let previous = "";
  for (const s of body.symbols) {
    if (assertScannerSymbol(s.symbol) !== s.symbol) invalid(`symbol ${s.symbol} is not canonical`);
    if (s.symbol <= previous) invalid("symbols must be sorted and unique");
    previous = s.symbol;
    if (!SHA.test(s.lineageId) || !SHA.test(s.bootstrapInputSha256)) invalid(`symbol ${s.symbol} has a malformed lineage`);
  }
  if (body.selection.acceptedEligible !== body.symbols.length) invalid("acceptedEligible differs from the symbols listed");
}

export function buildRunManifest(body: SupervisorRunManifestBody): SupervisorRunManifest {
  const sorted = { ...body, symbols: [...body.symbols].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)) };
  assertRunManifestBody(sorted);
  return { body: sorted, bodySha256: canonicalSha256(sorted) };
}

export const runManifestText = (manifest: SupervisorRunManifest) => `${canonicalJson(manifest)}\n`;

/** Parses and fully verifies a manifest file's text. */
export function parseRunManifest(text: string): SupervisorRunManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid("the run manifest is not JSON");
  }
  const manifest = parsed as SupervisorRunManifest;
  if (manifest === null || typeof manifest !== "object" || canonicalJson(Object.keys(manifest).sort()) !== canonicalJson(["body", "bodySha256"])) {
    invalid("the run manifest file has missing or extra fields");
  }
  assertRunManifestBody(manifest.body);
  if (manifest.bodySha256 !== canonicalSha256(manifest.body)) invalid("the run manifest does not match its hash");
  return manifest;
}

/** A compact, sortable, unique run id from a start time and 4 random bytes (hex). */
export function makeRunId(startedAtMs: number, randomHex8: string): string {
  if (!/^[0-9a-f]{8}$/.test(randomHex8)) invalid("the run id suffix must be 8 hex chars");
  const iso = new Date(startedAtMs).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z-${randomHex8}`;
}
