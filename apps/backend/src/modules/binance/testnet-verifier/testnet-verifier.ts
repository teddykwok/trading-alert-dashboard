import { BinanceError } from "../binance.errors";
import type { BinanceReadOnlyService } from "../binance-read-only.service";
import type { BinanceUsdMExecutionClient } from "../binance-execution.client";
import { classifyMutationOutcome, type MutationFailureShape } from "../../execution/entry-lifecycle";
import { classifyAlgoProbe, type AlgoProbeResult } from "./testnet-algo-probe";
import {
  confirmActiveProtection,
  isResolved,
  observeAlgoIdentity,
  type AlgoIdentityObservation,
  type IdentityLookup,
  type ProtectionExpectation,
} from "./testnet-algo-observation";
import { BINANCE_TESTNET_ORIGIN } from "./testnet-config";
import type { DocumentedFormClient } from "./testnet-documented-form";
import { TESTNET_VERIFIER_VERSION, deriveIdentities, ownsIdentity, type VerifierIdentities } from "./testnet-identities";
import {
  planLongTriggers,
  planMarketableLimitPrice,
  planMinimumQuantity,
  type VerifierSymbolFilters,
} from "./testnet-sizing";
import type { StateReadResult, StateStore, VerifierPhase, VerifierState } from "./testnet-state";

/**
 * The TESTNET protection verifier.
 *
 * It exercises the REAL production request builders — `submitLimitEntry`,
 * `submitProtectionOrder`, `cancelProtectionOrder`, `submitEmergencyMarketClose`
 * and their branded authorization factories — against the demo host, so what
 * is proven here is the production contract rather than a copy of it.
 *
 * Three invariants run through the whole file:
 *
 *  1. NOTHING IS INFERRED FROM A FAILED READ. A position, an order or a
 *     baseline that could not be read is UNKNOWN, never "flat" and never
 *     "absent". Only an explicit successful exchange read proves anything.
 *  2. A MUTATION HAPPENS ONLY WHEN THE EXCHANGE PROVES IT HAS NOT ALREADY
 *     HAPPENED. That is what makes a resume safe, and it is why the persisted
 *     phase is a permission ceiling rather than a resume instruction.
 *  3. IDENTITIES ARE OWNED BY DERIVATION. Every id comes from the persisted
 *     runId; nothing is ever matched by prefix.
 */

export type VerifierReadOnlyPort = Pick<
  BinanceReadOnlyService,
  | "checkConnection"
  | "getAccountSummary"
  | "inspectSymbol"
  | "getMarkPrice"
  | "getPositionForSide"
  | "getOpenOrders"
  | "getOpenAlgoOrders"
  | "queryAlgoOrderByClientAlgoId"
  | "queryOrderByClientOrderId"
>;

export type VerifierMutationPort = Pick<
  BinanceUsdMExecutionClient,
  | "authorizeLiveEntry"
  | "submitLimitEntry"
  | "authorizeProtectionSubmission"
  | "submitProtectionOrder"
  | "authorizeProtectionCancellation"
  | "cancelProtectionOrder"
  | "authorizeEmergencyClose"
  | "submitEmergencyMarketClose"
  | "authorizeEntryCancellation"
  | "cancelReservedEntryOrder"
>;

export type VerifierVerdict =
  | "PASS"
  /**
   * A retained state file was reconciled, every owned identity was proven
   * resolved and the position was proven flat — so the run had nothing left
   * to do and did not mutate anything.
   */
  | "RECOVERY_COMPLETE"
  | "FAIL_SAFE"
  | "NOT_SUPPORTED"
  | "MANUAL_TESTNET_CLEANUP_REQUIRED";

export interface VerifierOptions {
  readonly mode: "PROBE_ONLY" | "MUTATE";
  readonly symbol: string;
  readonly triggerOffsetBps: number;
  readonly entryCrossBps: number;
  /** Bounded poll for a definitive entry outcome. Never a blind resubmit. */
  readonly fillPollAttempts: number;
  readonly fillPollIntervalMs: number;
}

/** Read-only capability set. A probe run is given nothing more than this. */
export interface ProbeDeps {
  readonly readOnly: VerifierReadOnlyPort;
  readonly documented: Pick<DocumentedFormClient, "queryByClientAlgoId" | "cancelByClientAlgoId">;
  readonly identities: VerifierIdentities;
  readonly log: (line: string) => void;
}

export interface VerifierDeps extends ProbeDeps {
  readonly mutations: VerifierMutationPort;
  readonly state: StateStore & { readDetailed(): StateReadResult };
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Tri-state reads: UNAVAILABLE is never collapsed into FLAT or ABSENT
// ---------------------------------------------------------------------------

export type PositionRead =
  /** An explicit successful read showing no exposure. */
  | { readonly status: "FLAT" }
  | { readonly status: "OPEN"; readonly quantity: string }
  /** Timeout, network, auth, 5xx, malformed — anything we could not read. */
  | { readonly status: "UNAVAILABLE" };

/** State of ONE owned standard order, by its deterministic client id. */
export type OwnedEntryState = "ABSENT" | "OPEN" | "FILLED" | "TERMINAL" | "UNKNOWN";

export interface OwnedObservation {
  readonly entry: OwnedEntryState;
  readonly stop: AlgoIdentityObservation;
  readonly takeProfit: AlgoIdentityObservation;
  readonly longPosition: PositionRead;
}

/** Nothing is left to unwind for this entry identity. */
function entryResolved(state: OwnedEntryState): boolean {
  return state === "FILLED" || state === "TERMINAL" || state === "ABSENT";
}

const LONG = "LONG" as const;
const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;
const NO_SUCH_ORDER = -2013;

function isPositiveQuantity(value: string | null | undefined): value is string {
  return typeof value === "string" && PLAIN_DECIMAL.test(value.trim()) && /[1-9]/.test(value);
}

function isZeroQuantity(value: string): boolean {
  return /^-?0(\.0+)?$/.test(value.trim());
}

function failureShape(error: unknown): MutationFailureShape {
  if (error instanceof BinanceError) {
    return { kind: error.kind, httpStatus: error.httpStatus, binanceCode: error.binanceCode };
  }
  // An unrecognised throw is ambiguous by construction; it must never be read
  // as "nothing was created".
  return { kind: "NETWORK", httpStatus: null, binanceCode: null };
}

/** A definitive parameter-contract rejection — the ONLY unlock for the rescue. */
function isDefinitiveParameterRejection(error: unknown): boolean {
  return error instanceof BinanceError && error.kind === "REQUEST_INVALID";
}

/** True when the exchange definitively said this exact id does not exist. */
function provesAbsence(error: unknown): boolean {
  return error instanceof BinanceError && error.binanceCode === NO_SUCH_ORDER;
}

/**
 * Reads ONE position side.
 *
 * A successful call that returns no row for the symbol and side is FLAT:
 * `positionRisk` omits rows for contracts with no exposure, so the absence of
 * the row IS the exchange's answer. A row whose `positionAmt` cannot be parsed
 * is UNAVAILABLE, not flat — an unreadable field proves nothing. A throw of
 * any kind is UNAVAILABLE.
 */
export async function readPositionSide(
  readOnly: VerifierReadOnlyPort,
  symbol: string,
  positionSide: "LONG" | "SHORT"
): Promise<PositionRead> {
  try {
    const row = await readOnly.getPositionForSide(symbol, positionSide);
    if (row === null) return { status: "FLAT" };
    const amount = row.positionAmt;
    if (typeof amount !== "string") return { status: "UNAVAILABLE" };
    const trimmed = amount.trim();
    if (isZeroQuantity(trimmed)) return { status: "FLAT" };
    if (isPositiveQuantity(trimmed)) return { status: "OPEN", quantity: trimmed };
    // A negative amount on the LONG side, or an unparseable literal: we cannot
    // say what this is, so we say we do not know.
    return { status: "UNAVAILABLE" };
  } catch {
    return { status: "UNAVAILABLE" };
  }
}

async function readOwnedEntry(
  readOnly: VerifierReadOnlyPort,
  symbol: string,
  clientOrderId: string
): Promise<OwnedEntryState> {
  try {
    const order = await readOnly.queryOrderByClientOrderId(symbol, clientOrderId);
    if (order.clientOrderId !== clientOrderId) return "UNKNOWN";
    switch (order.status) {
      case "FILLED":
        return "FILLED";
      case "NEW":
      case "PARTIALLY_FILLED":
        return "OPEN";
      case "CANCELED":
      case "EXPIRED":
      case "REJECTED":
        return "TERMINAL";
      default:
        return "UNKNOWN";
    }
  } catch (error) {
    return provesAbsence(error) ? "ABSENT" : "UNKNOWN";
  }
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Observes ONE owned Algo identity through BOTH query forms.
 *
 * This replaces the earlier single-form read whose three-way collapse
 * ("accepted / null status") could not distinguish a found order from a
 * confirmed-absent one. Each form reports its own lookup and the combination
 * is resolved by `observeAlgoIdentity`.
 */
async function observeAlgoBothForms(
  deps: Pick<VerifierDeps, "readOnly" | "documented">,
  symbol: string,
  clientAlgoId: string
): Promise<AlgoIdentityObservation> {
  let production: { lookup: IdentityLookup; algoStatus?: string | null; orderType?: string | null; positionSide?: string | null; symbol?: string | null };
  try {
    const order = await deps.readOnly.queryAlgoOrderByClientAlgoId(symbol, clientAlgoId);
    production =
      order.clientAlgoId === clientAlgoId
        ? {
            lookup: "FOUND",
            algoStatus: order.algoStatus,
            orderType: order.orderType,
            positionSide: order.positionSide,
            symbol: order.symbol,
          }
        : // A reply about a DIFFERENT identity establishes nothing about ours.
          { lookup: "UNKNOWN" };
  } catch (error) {
    // A failed query is UNKNOWN. Only the documented -2013 proves absence.
    production = { lookup: provesAbsence(error) ? "CONFIRMED_ABSENT" : "UNKNOWN" };
  }

  const reply = await deps.documented.queryByClientAlgoId(clientAlgoId);
  let documented: {
    lookup: IdentityLookup;
    statusKeyPresent?: boolean;
    algoStatus?: string | null;
    orderType?: string | null;
    positionSide?: string | null;
    symbol?: string | null;
  };
  if (reply.outcome === "ACCEPTED" && reply.payload && textField(reply.payload.clientAlgoId) === clientAlgoId) {
    const payload = reply.payload;
    documented = {
      lookup: "FOUND",
      // The one place the RAW key presence is visible: this path keeps the
      // body, while the production path goes through the shared normalizer.
      statusKeyPresent: "algoStatus" in payload || "status" in payload,
      algoStatus: textField(payload.algoStatus) ?? textField(payload.status),
      orderType: textField(payload.orderType) ?? textField(payload.type),
      positionSide: textField(payload.positionSide),
      symbol: textField(payload.symbol),
    };
  } else if (reply.outcome === "REJECTED" && reply.binanceCode === NO_SUCH_ORDER) {
    documented = { lookup: "CONFIRMED_ABSENT" };
  } else {
    documented = { lookup: "UNKNOWN" };
  }

  return observeAlgoIdentity({ clientAlgoId, production, documented });
}

/** A synthesised observation for an identity a fresh run has never used. */
function neverSubmitted(clientAlgoId: string): AlgoIdentityObservation {
  return observeAlgoIdentity({
    clientAlgoId,
    production: { lookup: "NOT_ATTEMPTED" },
    documented: { lookup: "CONFIRMED_ABSENT" },
  });
}

// ---------------------------------------------------------------------------
// Phase permissions
// ---------------------------------------------------------------------------

export interface PhasePermits {
  readonly maySubmitEntry: boolean;
  readonly maySubmitStop: boolean;
  readonly maySubmitTakeProfit: boolean;
  readonly mayCancelOwned: boolean;
  readonly mayCloseOwned: boolean;
}

/**
 * What a run at a given persisted phase is PERMITTED to do — an upper bound,
 * never an instruction.
 *
 * Reading is always permitted; only mutations are constrained. Because the
 * state file is written BEFORE each mutation, phase P means "the mutation
 * that follows P may already have been dispatched", so P never re-authorises
 * that mutation. Every entry below is additionally gated at runtime by proof
 * from the exchange that the action has not already happened.
 *
 * Cancelling and closing OWNED identities stay permitted throughout: they are
 * the risk-REDUCING directions, and a resumed run must always be able to leave
 * the demo account clean.
 */
export const PHASE_PERMITS: Record<VerifierPhase, PhasePermits> = {
  //                    entry   stop    tp      cancel close
  PLANNED: permits(true, false, false, true, true),
  // The entry POST may already have gone out — never repeat it.
  ENTRY_SUBMITTED: permits(false, true, false, true, true),
  ENTRY_FILLED: permits(false, true, false, true, true),
  // The STOP POST may already have gone out — never repeat it.
  STOP_SUBMITTED: permits(false, false, true, true, true),
  STOP_CONFIRMED: permits(false, false, true, true, true),
  // The TP POST may already have gone out — never repeat it.
  TP_SUBMITTED: permits(false, false, false, true, true),
  TP_CONFIRMED: permits(false, false, false, true, true),
  CANCELLING: permits(false, false, false, true, true),
  CLOSING: permits(false, false, false, true, true),
  // The run finished. Nothing further is authorised.
  COMPLETE: permits(false, false, false, false, false),
};

function permits(
  maySubmitEntry: boolean,
  maySubmitStop: boolean,
  maySubmitTakeProfit: boolean,
  mayCancelOwned: boolean,
  mayCloseOwned: boolean
): PhasePermits {
  return { maySubmitEntry, maySubmitStop, maySubmitTakeProfit, mayCancelOwned, mayCloseOwned };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface BaselineReport {
  readonly longPosition: PositionRead["status"];
  readonly shortPosition: PositionRead["status"];
  /** null means the count could not be read — never treated as zero. */
  readonly standardOpenOrders: number | null;
  readonly algoOpenOrders: number | null;
  /** True only when all four were READ and all four were empty. */
  readonly clean: boolean;
}

export interface ProbeReport {
  readonly TESTNET_HOST_VERIFIED: boolean;
  readonly TESTNET_CREDENTIALS_WORK: boolean;
  readonly HEDGE_MODE: boolean | null;
  readonly BASELINE_POSITION_FLAT: boolean | null;
  readonly BASELINE_STANDARD_OPEN_ORDERS: number | null;
  readonly BASELINE_ALGO_OPEN_ORDERS: number | null;
  readonly BASELINE_CLEAN: boolean;
  readonly MARK_PRICE_AVAILABLE: boolean;
  readonly EXCHANGE_FILTERS_AVAILABLE: boolean;
  readonly ALGO_QUERY_ENDPOINT_SUPPORTED: boolean;
  /** Recorded separately — see the section 6 finding. Null when not attempted. */
  readonly PRODUCTION_QUERY_FORM_ACCEPTED: boolean | null;
  readonly DOCUMENTED_QUERY_FORM_ACCEPTED: boolean | null;
  readonly detail: string;
  readonly markPrice: string | null;
  readonly filters: VerifierSymbolFilters | null;
  readonly baseline: BaselineReport;
}

/** Sanitized per-identity diagnostics, surfaced so the NEXT demo run explains itself. */
export interface OrderObservation {
  readonly clientId: string;
  readonly outcome: AlgoIdentityObservation["outcome"];
  readonly identityFound: boolean;
  readonly rawStatusPresent: boolean | null;
  readonly normalizedStatus: string | null;
  readonly orderType: string | null;
  readonly positionSide: string | null;
  readonly symbol: string | null;
  readonly productionQueryForm: IdentityLookup;
  readonly documentedQueryForm: IdentityLookup;
  readonly confirmedActive: boolean;
  readonly confirmationReason: string;
}

export interface CancelReconciliation {
  readonly clientAlgoId: string;
  /** Whether the exact-id DELETE itself returned success. */
  readonly accepted: boolean;
  readonly productionFormResult: string;
  readonly queryAttempts: number;
  readonly finalOutcome: AlgoIdentityObservation["outcome"];
  readonly finalStatus: string | null;
  readonly resolved: boolean;
  readonly rescueUsed: boolean;
}

function toOrderObservation(
  observation: AlgoIdentityObservation,
  expected: ProtectionExpectation
): OrderObservation {
  const confirmation = confirmActiveProtection(observation, expected);
  return {
    clientId: observation.clientAlgoId,
    outcome: observation.outcome,
    identityFound: observation.identityFound,
    rawStatusPresent: observation.rawStatusPresent,
    normalizedStatus: observation.normalizedStatus,
    orderType: observation.orderType,
    positionSide: observation.positionSide,
    symbol: observation.symbol,
    productionQueryForm: observation.productionQueryForm,
    documentedQueryForm: observation.documentedQueryForm,
    confirmedActive: confirmation.confirmed,
    confirmationReason: confirmation.reason,
  };
}

export interface VerifierRunReport {
  readonly verdict: VerifierVerdict;
  readonly runId: string;
  readonly origin: string;
  readonly symbol: string;
  readonly resumedFromPhase: VerifierPhase | null;
  readonly probe: ProbeReport;
  readonly entry: { clientOrderId: string; status: string | null; actualQuantity: string | null } | null;
  readonly stop: OrderObservation | null;
  readonly takeProfit: OrderObservation | null;
  readonly cancel: {
    readonly stop: CancelReconciliation | null;
    readonly takeProfit: CancelReconciliation | null;
    readonly rescueUsed: boolean;
  } | null;
  readonly cleanup: {
    readonly entryRemainderResolved: boolean;
    readonly stopResolved: boolean;
    readonly takeProfitResolved: boolean;
    readonly positionFlat: boolean;
    /** True only when EVERY line above is proven. Drives state-file clearing. */
    readonly proven: boolean;
  } | null;
  readonly stateRetained: boolean;
  readonly failures: readonly string[];
}

// ===========================================================================
// MODE A — probe only.
//
// Takes ProbeDeps, which has no mutation port at all, so this function is
// structurally incapable of mutating anything.
// ===========================================================================

export async function runProbe(options: VerifierOptions, deps: ProbeDeps): Promise<ProbeReport> {
  const symbol = options.symbol.trim().toUpperCase();
  const notes: string[] = [];

  let credentialsWork = false;
  let hedgeMode: boolean | null = null;
  let markPrice: string | null = null;
  let filters: VerifierSymbolFilters | null = null;

  // 1. Connectivity + clock. Unsigned, so this proves reachability only.
  try {
    const connection = await deps.readOnly.checkConnection();
    if (connection.host !== new URL(BINANCE_TESTNET_ORIGIN).host) {
      notes.push(`Client host ${connection.host} is not the demo host.`);
    }
  } catch (error) {
    notes.push(`Connectivity check failed: ${describe(error)}`);
  }

  // 2. Signed account read — this is what proves the credentials work.
  try {
    const summary = await deps.readOnly.getAccountSummary();
    credentialsWork = true;
    hedgeMode = summary.positionMode === "HEDGE";
    if (!hedgeMode) notes.push(`Position mode is ${summary.positionMode ?? "unknown"}; HEDGE is required.`);
  } catch (error) {
    notes.push(`Signed account read failed: ${describe(error)}`);
  }

  // 3. Full baseline: BOTH position sides AND both open-order families.
  const baseline = credentialsWork
    ? await readBaseline(deps.readOnly, symbol)
    : unreadableBaseline();
  if (!baseline.clean) notes.push(baselineNote(symbol, baseline));

  // 4. Filters.
  try {
    const inspection = await deps.readOnly.inspectSymbol(symbol);
    filters = {
      tickSize: inspection.filters.tickSize,
      stepSize: inspection.filters.stepSize,
      minQty: inspection.filters.minQty,
      minNotional: inspection.filters.minNotional,
    };
  } catch (error) {
    notes.push(`exchangeInfo read failed: ${describe(error)}`);
  }

  // 5. Mark price (public premiumIndex — readable before any position).
  try {
    markPrice = (await deps.readOnly.getMarkPrice(symbol)).markPrice;
  } catch (error) {
    notes.push(`Mark price read failed: ${describe(error)}`);
  }

  // 6. The Algo capability probe, in the DOCUMENTED form. The documented form
  //    is what establishes ENDPOINT availability; asking in our own parameter
  //    shape would conflate "endpoint missing" with "our shape is wrong".
  const documentedProbe = await deps.documented.queryByClientAlgoId(deps.identities.probeClientAlgoId);
  const algo: AlgoProbeResult = classifyAlgoProbe({
    failure:
      documentedProbe.outcome === "ACCEPTED"
        ? null
        : {
            kind: documentedProbe.kind ?? "NETWORK",
            httpStatus: documentedProbe.httpStatus,
            binanceCode: documentedProbe.binanceCode,
          },
  });
  notes.push(algo.detail);

  // 7. The SAME impossible identity through the CURRENT production query
  //    method, which additionally sends `symbol`. Comparing the two answers
  //    settles the undocumented-parameter question with zero mutation.
  let productionQueryFormAccepted: boolean | null = null;
  let documentedQueryFormAccepted: boolean | null = null;
  if (algo.supported) {
    documentedQueryFormAccepted = true; // a served 4xx with -2013 is an answer
    try {
      await deps.readOnly.queryAlgoOrderByClientAlgoId(symbol, deps.identities.probeClientAlgoId);
      productionQueryFormAccepted = null;
      notes.push("Production query form returned a payload for an impossible id; treating the result as unusable.");
    } catch (error) {
      const shape = failureShape(error);
      productionQueryFormAccepted = shape.binanceCode === NO_SUCH_ORDER;
      if (!productionQueryFormAccepted) {
        notes.push(
          `Production query form (which also sends 'symbol') answered kind=${shape.kind} ` +
            `code=${shape.binanceCode ?? "—"} where the documented form answered -2013.`
        );
      }
    }
  }

  return {
    TESTNET_HOST_VERIFIED: true, // resolveTestnetConfig already proved this
    TESTNET_CREDENTIALS_WORK: credentialsWork,
    HEDGE_MODE: hedgeMode,
    BASELINE_POSITION_FLAT:
      baseline.longPosition === "UNAVAILABLE" || baseline.shortPosition === "UNAVAILABLE"
        ? null
        : baseline.longPosition === "FLAT" && baseline.shortPosition === "FLAT",
    BASELINE_STANDARD_OPEN_ORDERS: baseline.standardOpenOrders,
    BASELINE_ALGO_OPEN_ORDERS: baseline.algoOpenOrders,
    BASELINE_CLEAN: baseline.clean,
    MARK_PRICE_AVAILABLE: markPrice !== null,
    EXCHANGE_FILTERS_AVAILABLE: filters !== null,
    ALGO_QUERY_ENDPOINT_SUPPORTED: algo.supported,
    PRODUCTION_QUERY_FORM_ACCEPTED: productionQueryFormAccepted,
    DOCUMENTED_QUERY_FORM_ACCEPTED: documentedQueryFormAccepted,
    detail: notes.join(" | "),
    markPrice,
    filters,
    baseline,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

function unreadableBaseline(): BaselineReport {
  return {
    longPosition: "UNAVAILABLE",
    shortPosition: "UNAVAILABLE",
    standardOpenOrders: null,
    algoOpenOrders: null,
    clean: false,
  };
}

/**
 * Proves — or fails to prove — that the symbol carries no exposure and no
 * working orders of EITHER family.
 *
 * Every field is read explicitly. An unreadable count stays null and `clean`
 * stays false: "we could not look" is not "there is nothing there".
 */
async function readBaseline(readOnly: VerifierReadOnlyPort, symbol: string): Promise<BaselineReport> {
  const [longPosition, shortPosition] = await Promise.all([
    readPositionSide(readOnly, symbol, "LONG"),
    readPositionSide(readOnly, symbol, "SHORT"),
  ]);

  const standardOpenOrders = await readOnly
    .getOpenOrders(symbol)
    .then((orders) => orders.length)
    .catch(() => null);
  const algoOpenOrders = await readOnly
    .getOpenAlgoOrders(symbol)
    .then((orders) => orders.length)
    .catch(() => null);

  return {
    longPosition: longPosition.status,
    shortPosition: shortPosition.status,
    standardOpenOrders,
    algoOpenOrders,
    clean:
      longPosition.status === "FLAT" &&
      shortPosition.status === "FLAT" &&
      standardOpenOrders === 0 &&
      algoOpenOrders === 0,
  };
}

function baselineNote(symbol: string, baseline: BaselineReport): string {
  const parts: string[] = [];
  if (baseline.longPosition !== "FLAT") parts.push(`LONG position ${baseline.longPosition}`);
  if (baseline.shortPosition !== "FLAT") parts.push(`SHORT position ${baseline.shortPosition}`);
  if (baseline.standardOpenOrders === null) parts.push("standard open orders UNREADABLE");
  else if (baseline.standardOpenOrders > 0) parts.push(`${baseline.standardOpenOrders} standard open order(s)`);
  if (baseline.algoOpenOrders === null) parts.push("algo open orders UNREADABLE");
  else if (baseline.algoOpenOrders > 0) parts.push(`${baseline.algoOpenOrders} algo open order(s)`);
  return `${symbol} baseline is not clean: ${parts.join(", ")}.`;
}

// ===========================================================================
// MODE B — mutation verify
// ===========================================================================

interface Shell {
  readonly options: VerifierOptions;
  readonly deps: VerifierDeps;
  readonly probe: ProbeReport;
  readonly resumedFromPhase: VerifierPhase | null;
}

function bail(shell: Shell, verdict: VerifierVerdict, failures: string[], stateRetained: boolean): VerifierRunReport {
  return {
    verdict,
    runId: shell.deps.identities.runId,
    origin: BINANCE_TESTNET_ORIGIN,
    symbol: shell.options.symbol.trim().toUpperCase(),
    resumedFromPhase: shell.resumedFromPhase,
    probe: shell.probe,
    entry: null,
    stop: null,
    takeProfit: null,
    cancel: null,
    cleanup: null,
    stateRetained,
    failures,
  };
}

/**
 * Validates EVERY persisted field against identities freshly derived from the
 * stored runId, plus the version, origin, symbol and direction.
 *
 * A single mismatch means the file does not describe this run, and a run that
 * cannot trust its own state file must not mutate anything.
 */
export function validateStoredState(
  state: VerifierState,
  expected: { symbol: string; origin: string }
): string | null {
  if (state.verifierVersion !== TESTNET_VERIFIER_VERSION) {
    return `state was written by verifier ${state.verifierVersion}, this build is ${TESTNET_VERIFIER_VERSION}`;
  }
  if (state.origin !== expected.origin) return `state origin ${state.origin} is not ${expected.origin}`;
  if (state.symbol !== expected.symbol) return `state symbol ${state.symbol} is not ${expected.symbol}`;
  if (state.direction !== "LONG") return `state direction ${state.direction} is not LONG`;
  if (!(state.phase in PHASE_PERMITS)) return `state phase ${state.phase} is not a known phase`;

  let derived: VerifierIdentities;
  try {
    derived = deriveIdentities(state.runId);
  } catch {
    return `state runId ${state.runId} is not a valid verifier runId`;
  }

  // All four identities, not just one.
  const fields: Array<[string, string, string]> = [
    ["entryClientOrderId", state.entryClientOrderId, derived.entryClientOrderId],
    ["stopClientAlgoId", state.stopClientAlgoId, derived.stopClientAlgoId],
    ["takeProfitClientAlgoId", state.takeProfitClientAlgoId, derived.takeProfitClientAlgoId],
    ["emergencyClientOrderId", state.emergencyClientOrderId, derived.emergencyClientOrderId],
  ];
  for (const [name, stored, expectedValue] of fields) {
    if (stored !== expectedValue) return `stored ${name} does not match the identity derived from runId`;
  }
  return null;
}

export async function runVerification(options: VerifierOptions, deps: VerifierDeps): Promise<VerifierRunReport> {
  const symbol = options.symbol.trim().toUpperCase();

  // Every probe gate is re-evaluated HERE, in this process. A previous probe
  // result on disk can never unlock a mutation run.
  const probe = await runProbe(options, deps);
  const stored = deps.state.readDetailed();
  const resumedFromPhase = stored.status === "LOADED" ? stored.state.phase : null;
  const shell: Shell = { options, deps, probe, resumedFromPhase };

  if (!probe.ALGO_QUERY_ENDPOINT_SUPPORTED) {
    return bail(shell, "NOT_SUPPORTED", [
      "Algo query endpoint support was not proven on the demo host; exiting without mutation.",
    ], stored.status === "LOADED");
  }

  const gateFailures: string[] = [];
  if (!probe.TESTNET_CREDENTIALS_WORK) gateFailures.push("Signed testnet credentials did not work.");
  if (probe.HEDGE_MODE !== true) gateFailures.push("HEDGE mode is required and is never changed by this verifier.");
  if (!probe.MARK_PRICE_AVAILABLE) gateFailures.push("Mark price is unavailable.");
  if (!probe.EXCHANGE_FILTERS_AVAILABLE) gateFailures.push("Exchange filters are unavailable.");
  if (gateFailures.length > 0) return bail(shell, "FAIL_SAFE", gateFailures, stored.status === "LOADED");

  // -----------------------------------------------------------------------
  // Resume vs fresh
  // -----------------------------------------------------------------------
  if (stored.status === "UNREADABLE") {
    return bail(shell, "MANUAL_TESTNET_CLEANUP_REQUIRED", [
      "A verifier state file exists but could not be parsed. It may describe live orders; refusing to mutate.",
    ], true);
  }

  let phase: VerifierPhase;
  let observed: OwnedObservation;
  let createdAt: string;

  if (stored.status === "LOADED") {
    const mismatch = validateStoredState(stored.state, { symbol, origin: BINANCE_TESTNET_ORIGIN });
    if (mismatch) {
      return bail(shell, "MANUAL_TESTNET_CLEANUP_REQUIRED", [`Stored verifier state is not usable: ${mismatch}.`], true);
    }
    if (stored.state.runId !== deps.identities.runId) {
      return bail(shell, "MANUAL_TESTNET_CLEANUP_REQUIRED", [
        "The caller derived identities from a different runId than the state file; refusing to mutate.",
      ], true);
    }

    phase = stored.state.phase;
    createdAt = stored.state.createdAt;
    deps.log(`Resuming run ${stored.state.runId} from phase ${phase}; reconciling owned identities first.`);

    // TRUE RESUME: reconcile the exact persisted identities BEFORE any
    // mutation. The persisted phase never authorises a POST on its own.
    observed = await reconcileOwned(deps, symbol);

    if (observed.entry === "UNKNOWN" || observed.stop.outcome === "UNKNOWN" || observed.takeProfit.outcome === "UNKNOWN") {
      return bail(shell, "MANUAL_TESTNET_CLEANUP_REQUIRED", [
        `Owned identities could not be resolved on resume (entry=${observed.entry}, ` +
          `stop=${observed.stop.outcome}, takeProfit=${observed.takeProfit.outcome}); ` +
          "refusing to mutate without proof.",
      ], true);
    }
    if (observed.longPosition.status === "UNAVAILABLE") {
      return bail(shell, "MANUAL_TESTNET_CLEANUP_REQUIRED", [
        "The LONG position could not be read on resume; refusing to mutate without proof.",
      ], true);
    }

    // ---------------------------------------------------------------------
    // RECOVERY COMPLETE.
    //
    // Every owned identity is proven terminal or absent and the position is
    // proven flat, so this run has nothing left to do. It clears the state
    // file and returns WITHOUT submitting an entry, a stop, a take profit or
    // an emergency close, and without cancelling anything. Reaching this
    // branch is the whole point of retaining the file in the first place.
    // ---------------------------------------------------------------------
    if (
      entryResolved(observed.entry) &&
      isResolved(observed.stop) &&
      isResolved(observed.takeProfit) &&
      observed.longPosition.status === "FLAT"
    ) {
      deps.log(`Run ${stored.state.runId}: every owned identity is resolved and the position is flat.`);
      deps.state.clear();
      const expectation = (orderType: ProtectionExpectation["orderType"]): ProtectionExpectation => ({
        symbol,
        positionSide: LONG,
        orderType,
      });
      return {
        ...bail(shell, "RECOVERY_COMPLETE", [], false),
        entry: { clientOrderId: deps.identities.entryClientOrderId, status: observed.entry, actualQuantity: null },
        stop: toOrderObservation(observed.stop, expectation("STOP_MARKET")),
        takeProfit: toOrderObservation(observed.takeProfit, expectation("TAKE_PROFIT_MARKET")),
        cleanup: {
          entryRemainderResolved: true,
          stopResolved: true,
          takeProfitResolved: true,
          positionFlat: true,
          proven: true,
        },
      };
    }
  } else {
    // A fresh run demands a fully PROVEN-clean baseline: both position sides
    // flat AND both open-order families empty, all four explicitly read.
    if (!probe.BASELINE_CLEAN) {
      return bail(shell, "FAIL_SAFE", [baselineNote(symbol, probe.baseline)], false);
    }
    phase = "PLANNED";
    createdAt = deps.now().toISOString();
    // A fresh runId is random, so its identities cannot pre-exist; the clean
    // baseline has just proven the symbol carries no orders at all.
    observed = {
      entry: "ABSENT",
      stop: neverSubmitted(deps.identities.stopClientAlgoId),
      takeProfit: neverSubmitted(deps.identities.takeProfitClientAlgoId),
      longPosition: { status: "FLAT" },
    };
  }

  if (phase === "COMPLETE") {
    deps.state.clear();
    return bail(shell, "PASS", [], false);
  }

  return runFlow(shell, { phase, createdAt, observed });
}

/** Queries every owned identity and the LONG position by exact id. */
async function reconcileOwned(deps: VerifierDeps, symbol: string): Promise<OwnedObservation> {
  const [entry, stop, takeProfit, longPosition] = await Promise.all([
    readOwnedEntry(deps.readOnly, symbol, deps.identities.entryClientOrderId),
    observeAlgoBothForms(deps, symbol, deps.identities.stopClientAlgoId),
    observeAlgoBothForms(deps, symbol, deps.identities.takeProfitClientAlgoId),
    readPositionSide(deps.readOnly, symbol, LONG),
  ]);
  return { entry, stop, takeProfit, longPosition };
}

// ---------------------------------------------------------------------------
// The shared flow. A fresh run enters at PLANNED with everything ABSENT;
// a resumed run enters at its persisted phase with reconciled observations.
// ---------------------------------------------------------------------------

async function runFlow(
  shell: Shell,
  start: { phase: VerifierPhase; createdAt: string; observed: OwnedObservation }
): Promise<VerifierRunReport> {
  const { options, deps, probe } = shell;
  const symbol = options.symbol.trim().toUpperCase();
  const failures: string[] = [];

  const filters = probe.filters as VerifierSymbolFilters;
  const markPrice = probe.markPrice as string;

  let phase = start.phase;
  let permits = PHASE_PERMITS[phase];
  let observed = start.observed;

  const base: VerifierState = {
    verifierVersion: TESTNET_VERIFIER_VERSION,
    runId: deps.identities.runId,
    origin: BINANCE_TESTNET_ORIGIN,
    symbol,
    direction: LONG,
    entryClientOrderId: deps.identities.entryClientOrderId,
    stopClientAlgoId: deps.identities.stopClientAlgoId,
    takeProfitClientAlgoId: deps.identities.takeProfitClientAlgoId,
    emergencyClientOrderId: deps.identities.emergencyClientOrderId,
    phase,
    createdAt: start.createdAt,
    updatedAt: deps.now().toISOString(),
  };

  // Advancing the phase also advances the permission ceiling, so the fresh
  // path and the resume path are literally the same code.
  const advance = (next: VerifierPhase) => {
    phase = next;
    permits = PHASE_PERMITS[next];
    deps.state.write({ ...base, phase: next, updatedAt: deps.now().toISOString() });
  };

  // ---- Entry -------------------------------------------------------------
  let entryStatus: string | null = observed.entry === "ABSENT" ? null : observed.entry;

  if (permits.maySubmitEntry && observed.entry === "ABSENT") {
    const quantityPlan = planMinimumQuantity({ filters, markPrice });
    if (!quantityPlan.ok) return bail(shell, "FAIL_SAFE", [quantityPlan.message], false);

    const entryPricePlan = planMarketableLimitPrice({
      markPrice,
      tickSize: filters.tickSize,
      crossBps: options.entryCrossBps,
    });
    if (!entryPricePlan.ok) return bail(shell, "FAIL_SAFE", [entryPricePlan.message], false);

    // Persisted BEFORE the first mutation.
    advance("PLANNED");
    try {
      const authorization = deps.mutations.authorizeLiveEntry();
      const ack = await deps.mutations.submitLimitEntry(authorization, {
        symbol,
        side: "BUY",
        positionSide: LONG,
        quantity: quantityPlan.value.quantity,
        price: entryPricePlan.value.price,
        newClientOrderId: deps.identities.entryClientOrderId,
      });
      entryStatus = ack.status;
      advance("ENTRY_SUBMITTED");
    } catch (error) {
      advance("ENTRY_SUBMITTED");
      const outcome = classifyMutationOutcome(failureShape(error), "SUBMIT_ORDER");
      if (outcome === "CONFIRMED_REJECTED") {
        // Definitively nothing was created, so nothing is outstanding.
        deps.state.clear();
        return bail(shell, "FAIL_SAFE", [`Entry was definitively rejected: ${describe(error)}`], false);
      }
      deps.log("Entry submission was ambiguous; reconciling the same deterministic id.");
    }
  } else if (observed.entry !== "ABSENT") {
    deps.log(`Entry ${deps.identities.entryClientOrderId} already exists (${observed.entry}); not resubmitting.`);
  }

  // ---- Bounded wait for a definitive entry outcome -----------------------
  for (let attempt = 1; attempt <= options.fillPollAttempts; attempt += 1) {
    const state = await readOwnedEntry(deps.readOnly, symbol, deps.identities.entryClientOrderId);
    if (state === "FILLED" || state === "TERMINAL" || state === "ABSENT") {
      entryStatus = state;
      break;
    }
    entryStatus = state;
    if (attempt < options.fillPollAttempts) await deps.sleep(options.fillPollIntervalMs);
  }

  // ---- The ACTUAL confirmed position, never the requested quantity -------
  const position = await readPositionSide(deps.readOnly, symbol, LONG);
  const entryReport = {
    clientOrderId: deps.identities.entryClientOrderId,
    status: entryStatus,
    actualQuantity: position.status === "OPEN" ? position.quantity : null,
  };

  if (position.status === "UNAVAILABLE") {
    // We cannot say whether exposure exists, so we may not close and may not
    // declare anything clean.
    return {
      ...bail(shell, "MANUAL_TESTNET_CLEANUP_REQUIRED", [
        "The LONG position could not be read after entry; refusing to protect or close without proof.",
      ], true),
      entry: entryReport,
    };
  }

  if (position.status === "FLAT") {
    const cleanup = await cleanupRun(shell, permits, { filledQuantity: null, stopSubmitted: false, tpSubmitted: false });
    return finish(shell, {
      failures: ["The entry did not produce a confirmed position; nothing was protected."],
      entry: entryReport,
      stop: null,
      takeProfit: null,
      cancel: cleanup.cancel,
      cleanup: cleanup.report,
    });
  }

  const actualQuantity = position.quantity;
  if (phase === "PLANNED" || phase === "ENTRY_SUBMITTED") advance("ENTRY_FILLED");

  // ---- Triggers around the CURRENT mark ----------------------------------
  const freshMark = await deps.readOnly
    .getMarkPrice(symbol)
    .then((m) => m.markPrice)
    .catch(() => markPrice);
  const triggers = planLongTriggers({
    markPrice: freshMark,
    tickSize: filters.tickSize,
    triggerOffsetBps: options.triggerOffsetBps,
  });
  if (!triggers.ok) {
    const cleanup = await cleanupRun(shell, permits, {
      filledQuantity: actualQuantity,
      stopSubmitted: observed.stop.outcome !== "ABSENT_CONFIRMED",
      tpSubmitted: observed.takeProfit.outcome !== "ABSENT_CONFIRMED",
    });
    return finish(shell, {
      failures: [triggers.message],
      entry: entryReport,
      stop: null,
      takeProfit: null,
      cancel: cleanup.cancel,
      cleanup: cleanup.report,
    });
  }

  const expectation = (orderType: ProtectionExpectation["orderType"]): ProtectionExpectation => ({
    symbol,
    positionSide: LONG,
    orderType,
  });

  // ---- STOP FIRST --------------------------------------------------------
  // A submission requires PROOF of absence. IDENTITY_FOUND_STATUS_MISSING —
  // the shape the first real demo run produced — is NOT absence, so it can
  // never trigger a duplicate submission.
  let stopAttempted = observed.stop.outcome !== "ABSENT_CONFIRMED";
  if (observed.stop.outcome === "ABSENT_CONFIRMED") {
    if (!permits.maySubmitStop) {
      return {
        ...bail(shell, "MANUAL_TESTNET_CLEANUP_REQUIRED", [
          `Phase ${phase} does not authorise a STOP submission, and none exists. Manual review required.`,
        ], true),
        entry: entryReport,
      };
    }
    const result = await submitProtection(deps, {
      symbol,
      role: "STOP_LOSS",
      clientAlgoId: deps.identities.stopClientAlgoId,
      quantity: actualQuantity,
      triggerPrice: triggers.value.stopTriggerPrice,
    });
    stopAttempted = result.attempted;
    advance("STOP_SUBMITTED");
  } else {
    deps.log(`STOP ${deps.identities.stopClientAlgoId} already exists (${observed.stop.outcome}); not resubmitting.`);
  }

  // Bounded confirmation: identity + symbol + positionSide + orderType + a
  // recognised ACTIVE status. A matching clientAlgoId alone is NOT proof.
  const stopConfirm = await confirmBounded(shell, deps.identities.stopClientAlgoId, expectation("STOP_MARKET"));
  const stopObservation = toOrderObservation(stopConfirm.observation, expectation("STOP_MARKET"));

  if (!stopConfirm.confirmed) {
    // TAKE PROFIT IS NEVER SUBMITTED WITHOUT A CONFIRMED STOP.
    const cleanup = await cleanupRun(shell, permits, {
      filledQuantity: actualQuantity,
      stopSubmitted: stopAttempted,
      tpSubmitted: observed.takeProfit.outcome !== "ABSENT_CONFIRMED",
    });
    return finish(shell, {
      failures: [
        `STOP could not be confirmed active (${stopConfirm.reason}); the take profit was deliberately not submitted.`,
      ],
      entry: entryReport,
      stop: stopObservation,
      takeProfit: null,
      cancel: cleanup.cancel,
      cleanup: cleanup.report,
    });
  }
  if (phase === "STOP_SUBMITTED" || phase === "ENTRY_FILLED") advance("STOP_CONFIRMED");

  // ---- TAKE PROFIT second ------------------------------------------------
  let tpAttempted = observed.takeProfit.outcome !== "ABSENT_CONFIRMED";
  if (observed.takeProfit.outcome === "ABSENT_CONFIRMED") {
    if (!permits.maySubmitTakeProfit) {
      return {
        ...bail(shell, "MANUAL_TESTNET_CLEANUP_REQUIRED", [
          `Phase ${phase} does not authorise a TAKE_PROFIT submission, and none exists. Manual review required.`,
        ], true),
        entry: entryReport,
        stop: stopObservation,
      };
    }
    const result = await submitProtection(deps, {
      symbol,
      role: "TAKE_PROFIT",
      clientAlgoId: deps.identities.takeProfitClientAlgoId,
      quantity: actualQuantity,
      triggerPrice: triggers.value.takeProfitTriggerPrice,
    });
    tpAttempted = result.attempted;
    advance("TP_SUBMITTED");
  } else {
    deps.log(
      `TAKE_PROFIT ${deps.identities.takeProfitClientAlgoId} already exists ` +
        `(${observed.takeProfit.outcome}); not resubmitting.`
    );
  }

  const tpConfirm = await confirmBounded(
    shell,
    deps.identities.takeProfitClientAlgoId,
    expectation("TAKE_PROFIT_MARKET")
  );
  const tpObservation = toOrderObservation(tpConfirm.observation, expectation("TAKE_PROFIT_MARKET"));
  if (tpConfirm.confirmed) advance("TP_CONFIRMED");
  else failures.push(`TAKE_PROFIT could not be confirmed active (${tpConfirm.reason}).`);

  // ---- Cancel, then close ------------------------------------------------
  advance("CANCELLING");
  advance("CLOSING");
  const cleanup = await cleanupRun(shell, permits, {
    filledQuantity: actualQuantity,
    stopSubmitted: stopAttempted,
    tpSubmitted: tpAttempted,
  });
  if (cleanup.cancel.rescueUsed) deps.log("The documented rescue cancel was required.");
  for (const reconciliation of [cleanup.cancel.stop, cleanup.cancel.takeProfit]) {
    if (reconciliation && !reconciliation.resolved) {
      failures.push(
        `${reconciliation.clientAlgoId} was not proven resolved after cancellation ` +
          `(${reconciliation.finalOutcome} after ${reconciliation.queryAttempts} query attempt(s)).`
      );
    }
  }

  return finish(shell, {
    failures,
    entry: entryReport,
    stop: stopObservation,
    takeProfit: tpObservation,
    cancel: cleanup.cancel,
    cleanup: cleanup.report,
  });
}

/**
 * Decides the verdict and whether the state file survives.
 *
 * The state file exists so an interrupted run can be resumed. Once cleanup is
 * PROVEN complete there is nothing left to resume, so a stale file would only
 * cause the next run to reconcile ids that no longer matter — it is cleared
 * even when the run itself failed. Anything uncertain retains it.
 */
function finish(
  shell: Shell,
  parts: {
    failures: string[];
    entry: VerifierRunReport["entry"];
    stop: OrderObservation | null;
    takeProfit: OrderObservation | null;
    cancel: VerifierRunReport["cancel"];
    cleanup: NonNullable<VerifierRunReport["cleanup"]>;
  }
): VerifierRunReport {
  const proven = parts.cleanup.proven;
  if (proven) shell.deps.state.clear();

  const verdict: VerifierVerdict = !proven
    ? "MANUAL_TESTNET_CLEANUP_REQUIRED"
    : parts.failures.length > 0
      ? "FAIL_SAFE"
      : "PASS";

  return {
    verdict,
    runId: shell.deps.identities.runId,
    origin: BINANCE_TESTNET_ORIGIN,
    symbol: shell.options.symbol.trim().toUpperCase(),
    resumedFromPhase: shell.resumedFromPhase,
    probe: shell.probe,
    entry: parts.entry,
    stop: parts.stop,
    takeProfit: parts.takeProfit,
    cancel: parts.cancel,
    cleanup: parts.cleanup,
    stateRetained: !proven,
    failures: parts.failures,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * One protection submission through the production path, with ambiguity
 * resolved by querying the SAME deterministic id. No replacement identity is
 * ever generated and no POST is ever repeated.
 */
async function submitProtection(
  deps: VerifierDeps,
  input: {
    symbol: string;
    role: "STOP_LOSS" | "TAKE_PROFIT";
    clientAlgoId: string;
    quantity: string;
    triggerPrice: string;
  }
): Promise<{ attempted: boolean; present: boolean }> {
  const context = deps.mutations.authorizeProtectionSubmission({
    executionId: deps.identities.syntheticExecutionId,
    symbol: input.symbol,
    role: input.role,
    generation: 1,
    clientAlgoId: input.clientAlgoId,
    side: "SELL", // closing side for a LONG
    positionSide: LONG,
    quantity: input.quantity,
    triggerPrice: input.triggerPrice,
    workingType: "MARK_PRICE",
    priceProtect: false,
  });

  try {
    await deps.mutations.submitProtectionOrder(context);
    return { attempted: true, present: true };
  } catch (error) {
    // SUBMIT_ALGO: an unestablished duplicate semantic stays RESULT_UNKNOWN,
    // so the ONLY resolution is to ask about the same id.
    const outcome = classifyMutationOutcome(failureShape(error), "SUBMIT_ALGO");
    if (outcome === "CONFIRMED_REJECTED") {
      deps.log(`${input.role} was definitively rejected; not resubmitting.`);
      return { attempted: true, present: false };
    }
    deps.log(`${input.role} submission was ambiguous; querying the same clientAlgoId.`);
    const observation = await observeAlgoBothForms(deps, input.symbol, input.clientAlgoId);
    return { attempted: true, present: observation.identityFound };
  }
}

/**
 * Bounded confirmation of ONE owned protection identity.
 *
 * Re-queries the SAME clientAlgoId through both forms until it is confirmed
 * ACTIVE or the attempts run out. It never submits, never cancels and never
 * mints an identity — the only thing it can do is ask again.
 */
async function confirmBounded(
  shell: Shell,
  clientAlgoId: string,
  expected: ProtectionExpectation
): Promise<{ confirmed: boolean; reason: string; observation: AlgoIdentityObservation; attempts: number }> {
  const { deps, options } = shell;
  const symbol = options.symbol.trim().toUpperCase();

  let observation = await observeAlgoBothForms(deps, symbol, clientAlgoId);
  let result = confirmActiveProtection(observation, expected);
  let attempts = 1;

  while (!result.confirmed && attempts < options.fillPollAttempts) {
    // A TERMINAL identity will not become active by asking again.
    if (observation.outcome === "IDENTITY_FOUND_STATUS_TERMINAL") break;
    await deps.sleep(options.fillPollIntervalMs);
    attempts += 1;
    observation = await observeAlgoBothForms(deps, symbol, clientAlgoId);
    result = confirmActiveProtection(observation, expected);
  }

  return { ...result, observation, attempts };
}

/**
 * Cancels ONE owned identity and then PROVES the outcome.
 *
 * The first real demo run showed why this is necessary: both DELETEs returned
 * success, yet cleanup still found the stop unresolved moments later. An
 * accepted DELETE is an acknowledgement, not a terminal state — so after an
 * accepted cancel this runs a BOUNDED re-query of the same id:
 *
 *   · explicitly terminal status  -> RESOLVED
 *   · documented -2013            -> RESOLVED (absent)
 *   · still active                -> wait and ask again, NEVER a second DELETE
 *   · unreadable                  -> UNKNOWN, state retained, NEVER a second DELETE
 */
async function cancelAndReconcile(
  shell: Shell,
  clientAlgoId: string,
  role: "STOP_LOSS" | "TAKE_PROFIT"
): Promise<CancelReconciliation> {
  const { deps, options } = shell;
  const symbol = options.symbol.trim().toUpperCase();

  if (!ownsIdentity(deps.identities, clientAlgoId)) {
    // Unreachable by construction; the assertion is the point.
    throw new Error("Refusing to cancel an identity this verifier run did not derive.");
  }

  const before = await observeAlgoBothForms(deps, symbol, clientAlgoId);
  if (isResolved(before)) {
    // Already terminal or absent — nothing to cancel, so nothing is sent.
    return {
      clientAlgoId,
      accepted: false,
      productionFormResult: before.outcome,
      queryAttempts: 1,
      finalOutcome: before.outcome,
      finalStatus: before.normalizedStatus,
      resolved: true,
      rescueUsed: false,
    };
  }
  if (before.outcome === "UNKNOWN") {
    // We cannot see it, so we do not touch it.
    return {
      clientAlgoId,
      accepted: false,
      productionFormResult: "UNKNOWN",
      queryAttempts: 1,
      finalOutcome: "UNKNOWN",
      finalStatus: null,
      resolved: false,
      rescueUsed: false,
    };
  }

  let accepted = false;
  let rescueUsed = false;
  let productionFormResult: string;

  try {
    const context = deps.mutations.authorizeProtectionCancellation({
      executionId: deps.identities.syntheticExecutionId,
      symbol,
      role,
      generation: 1,
      clientAlgoId,
    });
    await deps.mutations.cancelProtectionOrder(context);
    accepted = true;
    productionFormResult = "ACCEPTED";
  } catch (error) {
    if (isDefinitiveParameterRejection(error)) {
      // The production form's parameter contract was refused. This is the ONLY
      // door to the rescue, and it exists purely so verifier-owned TESTNET
      // orders can still be cleaned up. It is NOT a production fix.
      const code = error instanceof BinanceError ? (error.binanceCode ?? "—") : "—";
      productionFormResult = `PRODUCTION_FORM_REJECTED:${code}`;
      const rescue = await deps.documented.cancelByClientAlgoId(clientAlgoId);
      rescueUsed = true;
      accepted = rescue.outcome === "ACCEPTED";
    } else {
      // Ambiguous. NO second DELETE — the reconciliation below decides.
      productionFormResult = "AMBIGUOUS";
    }
  }

  // Bounded proof of the outcome, whatever the DELETE returned. An accepted
  // DELETE is an acknowledgement, never a terminal state.
  let observation = before;
  let queryAttempts = 0;
  for (let attempt = 1; attempt <= options.fillPollAttempts; attempt += 1) {
    queryAttempts = attempt;
    observation = await observeAlgoBothForms(deps, symbol, clientAlgoId);
    if (isResolved(observation)) break;
    if (attempt < options.fillPollAttempts) await deps.sleep(options.fillPollIntervalMs);
  }

  return {
    clientAlgoId,
    accepted,
    productionFormResult,
    queryAttempts,
    finalOutcome: observation.outcome,
    finalStatus: observation.normalizedStatus,
    resolved: isResolved(observation),
    rescueUsed,
  };
}

/**
 * Closes ONLY the exposure this run created, cancels ONLY identities it owns,
 * and verifies every outcome.
 *
 * A position read that fails at ANY point leaves `positionFlat` false. That is
 * the whole point: "we could not read it" must never be recorded as "it is
 * gone", either before the close or when verifying it afterwards. The same
 * rule governs the protection identities — a failed production query stays
 * UNKNOWN until a documented exact-id query definitively answers -2013.
 */
async function cleanupRun(
  shell: Shell,
  permits: PhasePermits,
  input: { filledQuantity: string | null; stopSubmitted: boolean; tpSubmitted: boolean }
): Promise<{
  report: NonNullable<VerifierRunReport["cleanup"]>;
  cancel: NonNullable<VerifierRunReport["cancel"]>;
}> {
  const { deps, options } = shell;
  const symbol = options.symbol.trim().toUpperCase();

  // ---- Cancel owned protection, then PROVE the outcome -------------------
  let stopCancel: CancelReconciliation | null = null;
  let takeProfitCancel: CancelReconciliation | null = null;
  if (permits.mayCancelOwned) {
    stopCancel = await cancelAndReconcile(shell, deps.identities.stopClientAlgoId, "STOP_LOSS");
    takeProfitCancel = await cancelAndReconcile(shell, deps.identities.takeProfitClientAlgoId, "TAKE_PROFIT");
  }

  // ---- Entry remainder: only by the verifier's own deterministic id ------
  let entryRemainderResolved = false;
  const entryState = await readOwnedEntry(deps.readOnly, symbol, deps.identities.entryClientOrderId);
  if (entryResolved(entryState)) {
    entryRemainderResolved = true;
  } else if (entryState === "OPEN" && permits.mayCancelOwned) {
    try {
      const context = deps.mutations.authorizeEntryCancellation({
        executionId: deps.identities.syntheticExecutionId,
        symbol,
        clientOrderId: deps.identities.entryClientOrderId,
        role: "ENTRY",
        generation: 1,
        reason: "OPERATOR_RECOVERY",
      });
      await deps.mutations.cancelReservedEntryOrder(context);
      entryRemainderResolved = entryResolved(
        await readOwnedEntry(deps.readOnly, symbol, deps.identities.entryClientOrderId)
      );
    } catch {
      entryRemainderResolved = false;
    }
  }

  // ---- Close ONLY the LONG exposure, and only after proving it is ours ---
  let positionFlat = false;
  const before = await readPositionSide(deps.readOnly, symbol, LONG);

  if (before.status === "FLAT") {
    positionFlat = true;
  } else if (before.status === "UNAVAILABLE") {
    // Unreadable before the close: no close is attempted and nothing is flat.
    deps.log("The LONG position could not be read; refusing to close and refusing to claim flat.");
  } else if (input.filledQuantity && before.quantity === input.filledQuantity && permits.mayCloseOwned) {
    try {
      const context = deps.mutations.authorizeEmergencyClose({
        executionId: deps.identities.syntheticExecutionId,
        symbol,
        side: "SELL",
        positionSide: LONG,
        quantity: before.quantity,
        clientOrderId: deps.identities.emergencyClientOrderId,
      });
      await deps.mutations.submitEmergencyMarketClose(context);
      // A failed VERIFICATION read is not proof of a flat position either.
      const after = await readPositionSide(deps.readOnly, symbol, LONG);
      positionFlat = after.status === "FLAT";
      if (after.status === "UNAVAILABLE") {
        deps.log("The position could not be re-read after the close; not claiming flat.");
      }
    } catch {
      positionFlat = false;
    }
  } else {
    // The observed exposure is not the exposure this run created. Closing it
    // would be closing something we cannot prove we own.
    deps.log("Observed LONG exposure does not match this run's filled quantity; refusing to close it.");
  }

  // ---- Final resolution proof for both protection identities -------------
  const finalState = async (clientAlgoId: string, reconciliation: CancelReconciliation | null): Promise<boolean> => {
    if (reconciliation?.resolved) return true;
    return isResolved(await observeAlgoBothForms(deps, symbol, clientAlgoId));
  };

  const stopResolved = await finalState(deps.identities.stopClientAlgoId, stopCancel);
  const takeProfitResolved = await finalState(deps.identities.takeProfitClientAlgoId, takeProfitCancel);

  return {
    report: {
      entryRemainderResolved,
      stopResolved,
      takeProfitResolved,
      positionFlat,
      proven: entryRemainderResolved && positionFlat && stopResolved && takeProfitResolved,
    },
    cancel: {
      stop: stopCancel,
      takeProfit: takeProfitCancel,
      rescueUsed: Boolean(stopCancel?.rescueUsed || takeProfitCancel?.rescueUsed),
    },
  };
}
