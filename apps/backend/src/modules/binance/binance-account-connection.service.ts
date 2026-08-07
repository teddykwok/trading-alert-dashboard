import { env } from "../../config/env";
import { BinanceReadOnlyService } from "./binance-read-only.service";
import { BinanceError } from "./binance.errors";
import {
  BinanceAccountSetupClient,
  BinanceAccountSetupDisabledError,
} from "./binance-account-setup.client";
import {
  EXPECTED_ASSET_MODE,
  EXPECTED_POSITION_MODE,
  evaluateConnectionReadiness,
  evaluateReadiness,
  evaluateTestOrderOutcome,
  validateTestOrderAgainstFilters,
  type BinanceAccountHealthDto,
  type HedgeModeOutcome,
  type TestOrderOutcome,
  type TestOrderValidationCode,
} from "./binance-account-connection";

/**
 * Phase 10 — Binance account connection, mode verification and test-order
 * validation.
 *
 * Three responsibilities, deliberately separated:
 *
 *  1. `checkAccountConnection()` — READ-ONLY. Uses only Phase 2 GET capability
 *     and mutates nothing, anywhere. Safe to run at any time against a real
 *     account.
 *  2. `ensureHedgeMode()` — the one operator maintenance mutation, guarded by
 *     an account-wide preflight, a gate, an explicit authorization context and
 *     a TOCTOU re-check.
 *  3. `validateTestOrder()` — POST /fapi/v1/order/test with a before/after
 *     real-open-order invariant.
 *
 * This service touches NO execution state. It creates no TradeExecution, no
 * BinanceOrder, no ExecutionProtectionState, no SafetyAdmission and no
 * notification; it imports no Prisma client at all, so none of that is even
 * expressible here. It is account readiness only.
 */

export interface AccountConnectionServiceOptions {
  readOnly?: BinanceReadOnlyService;
  setupClient?: BinanceAccountSetupClient;
  liveEntryEnabled?: boolean;
  protectionReady?: boolean;
  accountSetupMutationsEnabled?: boolean;
  testOrderEnabled?: boolean;
}

export interface HedgeModeResult {
  outcome: HedgeModeOutcome;
  /** Mode observed before any decision. */
  positionModeBefore: string | null;
  /** Mode proven by a fresh GET afterwards; null when never confirmed. */
  positionModeAfter: string | null;
  nonZeroPositionCount: number | null;
  openOrderCount: number | null;
  mutationsDispatched: number;
  message: string;
}

export interface TestOrderRequest {
  symbol: string;
  positionSide: "LONG" | "SHORT";
  quantity: string;
  price: string;
}

export interface TestOrderResult {
  outcome: TestOrderOutcome;
  realOpenOrdersChanged: boolean;
  openOrderCountBefore: number | null;
  openOrderCountAfter: number | null;
  validationViolations: TestOrderValidationCode[];
  /** The test-only client id that was sent, safe to display. */
  clientOrderId: string | null;
  mutationsDispatched: number;
  message: string;
}

/** Bounded: an ambiguous validation call is retried at most this many times. */
export const TEST_ORDER_MAX_ATTEMPTS = 2;

export class BinanceAccountConnectionService {
  private readonly readOnly: BinanceReadOnlyService;
  private readonly setupClient: BinanceAccountSetupClient;
  private readonly liveEntryEnabled: boolean;
  private readonly protectionReady: boolean;
  private readonly accountSetupMutationsEnabled: boolean;
  private readonly testOrderEnabled: boolean;

  constructor(options: AccountConnectionServiceOptions = {}) {
    this.readOnly = options.readOnly ?? new BinanceReadOnlyService();
    this.setupClient = options.setupClient ?? new BinanceAccountSetupClient();
    this.liveEntryEnabled = options.liveEntryEnabled ?? env.EXECUTION_LIVE_ENTRY_ENABLED;
    this.protectionReady = options.protectionReady ?? env.EXECUTION_PROTECTION_READY;
    this.accountSetupMutationsEnabled =
      options.accountSetupMutationsEnabled ?? env.BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED;
    this.testOrderEnabled = options.testOrderEnabled ?? env.BINANCE_TEST_ORDER_ENABLED;
  }

  // -------------------------------------------------------------------------
  // 1. Read-only health check
  // -------------------------------------------------------------------------

  /**
   * A complete, sanitized picture of whether this key can talk to USDⓈ-M
   * futures and whether the account is configured the way the execution policy
   * expects.
   *
   * Issues only allowlisted GETs. It never changes position mode, asset mode,
   * leverage or margin type — a ONE_WAY or MULTI_ASSET account is REPORTED, not
   * corrected, because changing an account-wide setting is an explicit operator
   * decision and never a side effect of asking how things are.
   *
   * Every optional read degrades into a warning rather than failing the whole
   * check, so a partially-permissioned key still yields a useful report.
   */
  async checkAccountConnection(symbol = "BTCUSDT"): Promise<BinanceAccountHealthDto> {
    const warnings: string[] = [];
    const checkedAt = new Date().toISOString();

    let serverTimeReachable = false;
    let clockOffsetMs: number | null = null;
    let clockSyncFailed = false;
    try {
      const connection = await this.readOnly.checkConnection();
      serverTimeReachable = connection.ok;
      clockOffsetMs = connection.clockOffsetMs;
    } catch (error) {
      clockSyncFailed = true;
      warnings.push(`Server time / clock sync unavailable (${this.reason(error)}).`);
    }

    // The signed read that proves authentication and signing both work.
    let signedRequestWorks = false;
    let futuresAccountReachable = false;
    let authenticationFailed = false;
    let positionMode: string | null = null;
    try {
      positionMode = await this.readPositionMode();
      signedRequestWorks = true;
      futuresAccountReachable = true;
    } catch (error) {
      if (error instanceof BinanceError && (error.kind === "AUTH" || error.kind === "MISSING_CREDENTIALS")) {
        authenticationFailed = true;
      }
      warnings.push(`Signed futures request failed (${this.reason(error)}).`);
    }

    const assetMode = await this.optional(
      () => this.readAssetMode(),
      "Asset mode unavailable",
      warnings
    );

    const nonZeroPositionCount = await this.optional(
      async () => (await this.readOnly.getPositionRisk()).length,
      "Account-wide position count unavailable",
      warnings
    );
    const openOrderCount = await this.optional(
      async () => (await this.readOnly.getOpenOrders()).length,
      "Account-wide open-order count unavailable",
      warnings
    );

    // Symbol configuration and leverage brackets both come from inspectSymbol.
    let symbolConfigReachable = false;
    let leverageBracketReachable = false;
    try {
      const inspection = await this.readOnly.inspectSymbol(symbol);
      symbolConfigReachable = inspection.filters.symbol !== "";
      leverageBracketReachable = inspection.brackets.length > 0;
    } catch (error) {
      warnings.push(`Symbol configuration / leverage brackets unavailable (${this.reason(error)}).`);
    }

    if (positionMode !== null && positionMode !== EXPECTED_POSITION_MODE) {
      warnings.push(
        `Position mode is ${positionMode}; this project expects ${EXPECTED_POSITION_MODE}. It was NOT changed.`
      );
    }
    if (assetMode !== null && assetMode !== EXPECTED_ASSET_MODE) {
      warnings.push(
        `Asset mode is ${assetMode}; this project expects ${EXPECTED_ASSET_MODE}. It was NOT changed.`
      );
    }

    const { codes, accountSetupSafe } = evaluateReadiness({
      serverTimeReachable,
      signedRequestWorks,
      futuresAccountReachable,
      positionMode,
      assetMode,
      nonZeroPositionCount,
      openOrderCount,
      authenticationFailed,
      clockSyncFailed,
    });

    if (!accountSetupSafe && ((nonZeroPositionCount ?? 0) > 0 || (openOrderCount ?? 0) > 0)) {
      warnings.push(
        "The account holds existing exposure or open orders. Hedge-mode setup is blocked; " +
          "decide what to do with that exposure manually — nothing here will cancel or close anything."
      );
    }

    return {
      connected: codes.includes("CONNECTED"),
      serverTimeReachable,
      signedRequestWorks,
      futuresAccountReachable,
      positionMode,
      assetMode,
      nonZeroPositionCount,
      openOrderCount,
      symbolConfigReachable,
      leverageBracketReachable,
      clockOffsetMs,
      accountSetupSafe,
      testOrderCapabilityConfigured: this.testOrderEnabled,
      accountSetupMutationsConfigured: this.accountSetupMutationsEnabled,
      liveEntryEnabled: this.liveEntryEnabled,
      protectionReady: this.protectionReady,
      readinessCodes: codes,
      readinessState: evaluateConnectionReadiness({
        codes,
        positionMode,
        assetMode,
        testOrderEnabled: this.testOrderEnabled,
        testOrderValidated: false,
      }),
      checkedAt,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // 2. Hedge mode
  // -------------------------------------------------------------------------

  /**
   * Brings the account to HEDGE mode, or explains why it will not.
   *
   * Binance position mode is ACCOUNT-WIDE for USDⓈ-M, so the preflight inspects
   * the entire account rather than one symbol: a position or resting order on
   * any unrelated symbol blocks the change, because the change would affect it
   * too.
   *
   * Ordering matters and is deliberate:
   *   read mode -> already HEDGE? stop -> gate -> account-wide counts ->
   *   TOCTOU re-read -> authorize -> single POST -> verify with a fresh GET.
   *
   * Never cancels an order, never closes or reduces a position, never transfers
   * anything, never touches leverage, margin type or asset mode, and never
   * switches back to ONE_WAY.
   */
  async ensureHedgeMode(): Promise<HedgeModeResult> {
    const before = this.setupClient.mutationsDispatched;
    const result = await this.runEnsureHedgeMode();
    return { ...result, mutationsDispatched: this.setupClient.mutationsDispatched - before };
  }

  private async runEnsureHedgeMode(): Promise<Omit<HedgeModeResult, "mutationsDispatched">> {
    let positionModeBefore: string | null = null;
    try {
      positionModeBefore = await this.readPositionMode();
    } catch (error) {
      return this.hedgeResult(
        "POSITION_MODE_UNKNOWN",
        null,
        null,
        null,
        null,
        `Current position mode could not be read (${this.reason(error)}); nothing was changed.`
      );
    }

    if (positionModeBefore === "HEDGE") {
      // No POST at all — the account is already where it needs to be.
      return this.hedgeResult(
        "ALREADY_HEDGE",
        positionModeBefore,
        positionModeBefore,
        null,
        null,
        "The account is already in HEDGE mode; no request was sent."
      );
    }
    if (positionModeBefore === null) {
      return this.hedgeResult(
        "POSITION_MODE_UNKNOWN",
        null,
        null,
        null,
        null,
        "Binance did not report a recognisable position mode; nothing was changed."
      );
    }

    if (!this.accountSetupMutationsEnabled) {
      return this.hedgeResult(
        "MUTATIONS_DISABLED",
        positionModeBefore,
        null,
        null,
        null,
        "BINANCE_ACCOUNT_SETUP_MUTATIONS_ENABLED is false; no request was sent."
      );
    }

    // --- Account-wide preflight -------------------------------------------
    const preflight = await this.readAccountWideState();
    if (preflight === null) {
      return this.hedgeResult(
        "ACCOUNT_SETUP_BLOCKED",
        positionModeBefore,
        null,
        null,
        null,
        "Account-wide positions or open orders could not be read; nothing was changed."
      );
    }
    if (preflight.positions > 0 || preflight.orders > 0) {
      return this.hedgeResult(
        preflight.positions > 0 ? "ACCOUNT_SETUP_BLOCKED" : "ACCOUNT_SETUP_BLOCKED",
        positionModeBefore,
        null,
        preflight.positions,
        preflight.orders,
        preflight.positions > 0
          ? "The account holds at least one non-zero position; hedge mode was NOT changed. Resolve the exposure manually."
          : "The account has at least one open order; hedge mode was NOT changed. Resolve the orders manually."
      );
    }

    // --- TOCTOU re-check, immediately before the POST ----------------------
    // The account is not frozen while we work: a fill or a manual order could
    // land between the preflight and the mutation, and switching position mode
    // underneath live exposure is exactly what must never happen.
    const recheck = await this.readAccountWideState();
    if (recheck === null || recheck.positions > 0 || recheck.orders > 0) {
      return this.hedgeResult(
        "ACCOUNT_STATE_CHANGED",
        positionModeBefore,
        null,
        recheck?.positions ?? null,
        recheck?.orders ?? null,
        "Account state changed between preflight and the request; nothing was sent."
      );
    }

    let authorization;
    try {
      authorization = this.setupClient.authorizeHedgeMode({
        observedPositionMode: positionModeBefore,
        nonZeroPositionCount: recheck.positions,
        openOrderCount: recheck.orders,
      });
    } catch (error) {
      if (error instanceof BinanceAccountSetupDisabledError) {
        return this.hedgeResult(
          "MUTATIONS_DISABLED",
          positionModeBefore,
          null,
          recheck.positions,
          recheck.orders,
          "Account-setup mutations are disabled; no request was sent."
        );
      }
      throw error;
    }

    // --- The single POST ---------------------------------------------------
    let dispatchFailed = false;
    try {
      await this.setupClient.setHedgeMode(authorization);
    } catch (error) {
      // A timeout, reset or 5xx is NOT proof of failure: the change may have
      // landed. The verification GET below decides, and there is deliberately
      // no blind retry.
      dispatchFailed = true;
      void error;
    }

    // --- Verification: the response is never trusted on its own -------------
    let positionModeAfter: string | null = null;
    try {
      positionModeAfter = await this.readPositionMode();
    } catch {
      return this.hedgeResult(
        "HEDGE_MODE_NOT_VERIFIED",
        positionModeBefore,
        null,
        recheck.positions,
        recheck.orders,
        "The result could not be verified; re-run the health check before doing anything else. No retry was attempted."
      );
    }

    if (positionModeAfter === "HEDGE") {
      return this.hedgeResult(
        "HEDGE_MODE_SET",
        positionModeBefore,
        positionModeAfter,
        recheck.positions,
        recheck.orders,
        dispatchFailed
          ? "The request returned an ambiguous result, but HEDGE mode is now verified by a fresh read."
          : "HEDGE mode is set and verified by a fresh read."
      );
    }

    return this.hedgeResult(
      "HEDGE_MODE_NOT_VERIFIED",
      positionModeBefore,
      positionModeAfter,
      recheck.positions,
      recheck.orders,
      `Position mode still reads ${positionModeAfter ?? "unknown"} after the request; stopping. Nothing was retried and nothing was rolled back.`
    );
  }

  // -------------------------------------------------------------------------
  // 3. Test order
  // -------------------------------------------------------------------------

  /**
   * Validates a synthetic LIMIT request through POST /fapi/v1/order/test.
   *
   * The endpoint is non-matching: it validates and returns without ever
   * reaching the order book. That is asserted rather than assumed — the
   * account-wide open-order count is read BEFORE and AFTER, and any change is
   * reported as CRITICAL_TEST_INVARIANT_VIOLATION.
   *
   * On an ambiguous result there is a small bounded retry. It never falls back
   * to POST /fapi/v1/order — that endpoint is not reachable from this module at
   * all.
   */
  async validateTestOrder(request: TestOrderRequest): Promise<TestOrderResult> {
    const before = this.setupClient.mutationsDispatched;
    const result = await this.runValidateTestOrder(request);
    return { ...result, mutationsDispatched: this.setupClient.mutationsDispatched - before };
  }

  private async runValidateTestOrder(
    request: TestOrderRequest
  ): Promise<Omit<TestOrderResult, "mutationsDispatched">> {
    const symbol = request.symbol.trim().toUpperCase();

    if (!this.testOrderEnabled) {
      return this.testResult(
        "TEST_ORDER_FAILED",
        false,
        null,
        null,
        [],
        null,
        "BINANCE_TEST_ORDER_ENABLED is false; no request was sent."
      );
    }

    // --- Account mode must match before validating anything ----------------
    const positionMode = await this.safely(() => this.readPositionMode());
    if (positionMode !== EXPECTED_POSITION_MODE) {
      return this.testResult(
        "TEST_ORDER_FAILED",
        false,
        null,
        null,
        [],
        null,
        `Position mode is ${positionMode ?? "unknown"}; ${EXPECTED_POSITION_MODE} is required before a hedge-mode test order.`
      );
    }
    const assetMode = await this.safely(() => this.readAssetMode());
    if (assetMode !== EXPECTED_ASSET_MODE) {
      return this.testResult(
        "TEST_ORDER_FAILED",
        false,
        null,
        null,
        [],
        null,
        `Asset mode is ${assetMode ?? "unknown"}; ${EXPECTED_ASSET_MODE} is required.`
      );
    }

    // --- Local filter validation, before any network write -----------------
    let filters;
    try {
      filters = (await this.readOnly.inspectSymbol(symbol)).filters;
    } catch (error) {
      return this.testResult(
        "TEST_ORDER_FAILED",
        false,
        null,
        null,
        [],
        null,
        `Symbol ${symbol} could not be inspected (${this.reason(error)}); nothing was sent.`
      );
    }

    const validation = validateTestOrderAgainstFilters({ filters, price: request.price, quantity: request.quantity });
    if (!validation.valid) {
      // Rejected locally, verbatim — nothing is rounded to make it fit.
      return this.testResult(
        "TEST_ORDER_FAILED",
        false,
        null,
        null,
        validation.violations,
        null,
        `Rejected locally: ${validation.messages.join(" ")}`
      );
    }

    // --- The invariant baseline -------------------------------------------
    const openOrderCountBefore = await this.safely(async () => (await this.readOnly.getOpenOrders()).length);

    const authorization = this.setupClient.authorizeTestOrder({
      symbol,
      side: request.positionSide === "LONG" ? "BUY" : "SELL",
      positionSide: request.positionSide,
      quantity: request.quantity,
      price: request.price,
    });

    let accepted = false;
    let resultUnknown = false;
    let failureMessage = "";
    for (let attempt = 1; attempt <= TEST_ORDER_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.setupClient.submitUsdMFuturesTestOrder(authorization);
        accepted = true;
        resultUnknown = false;
        break;
      } catch (error) {
        const kind = error instanceof BinanceError ? error.kind : "UNKNOWN";
        // Only a genuinely ambiguous transport result is worth another attempt,
        // and only within the bounded budget. A rejection is final: retrying a
        // request Binance already refused would just repeat the refusal.
        const ambiguous = kind === "TIMEOUT" || kind === "NETWORK" || kind === "SERVER";
        failureMessage = error instanceof BinanceError ? error.message : "Test order failed.";
        if (!ambiguous) {
          accepted = false;
          resultUnknown = false;
          break;
        }
        resultUnknown = true;
      }
    }

    const openOrderCountAfter = await this.safely(async () => (await this.readOnly.getOpenOrders()).length);
    const { outcome, realOpenOrdersChanged } = evaluateTestOrderOutcome({
      openOrderCountBefore,
      openOrderCountAfter,
      accepted,
      resultUnknown,
    });

    const message =
      outcome === "CRITICAL_TEST_INVARIANT_VIOLATION"
        ? "The account-wide open-order count CHANGED across a non-matching test request. Stopping. Nothing was cancelled — investigate manually before doing anything else."
        : outcome === "TEST_ORDER_VALIDATED"
          ? "Binance accepted the test request: authentication, signing and the parameters are valid. No order was created."
          : outcome === "TEST_ORDER_RESULT_UNKNOWN"
            ? "The test request result is unknown after a bounded retry. No real order endpoint was contacted and the open-order count is unchanged."
            : `Binance rejected the test request: ${failureMessage}`;

    return this.testResult(
      outcome,
      realOpenOrdersChanged,
      openOrderCountBefore,
      openOrderCountAfter,
      [],
      authorization.clientOrderId,
      message
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** GET /fapi/v1/positionSide/dual through the read-only summary path. */
  private async readPositionMode(): Promise<string | null> {
    const summary = await this.readOnly.getAccountSummary();
    return summary.positionMode;
  }

  private async readAssetMode(): Promise<string | null> {
    const summary = await this.readOnly.getAccountSummary();
    return summary.assetMode;
  }

  /** Account-wide counts. Null when either read failed — never assumed zero. */
  private async readAccountWideState(): Promise<{ positions: number; orders: number } | null> {
    try {
      // No symbol filter on purpose: position mode is account-wide, so the
      // preflight must be too.
      const [positions, orders] = await Promise.all([
        this.readOnly.getPositionRisk(),
        this.readOnly.getOpenOrders(),
      ]);
      return { positions: positions.length, orders: orders.length };
    } catch {
      return null;
    }
  }

  private async safely<T>(run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch {
      return null;
    }
  }

  private async optional<T>(run: () => Promise<T>, prefix: string, warnings: string[]): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      warnings.push(`${prefix} (${this.reason(error)}).`);
      return null;
    }
  }

  /** Error KIND only — never a message that could carry request context. */
  private reason(error: unknown): string {
    return error instanceof BinanceError ? error.kind : "unknown error";
  }

  private hedgeResult(
    outcome: HedgeModeOutcome,
    positionModeBefore: string | null,
    positionModeAfter: string | null,
    nonZeroPositionCount: number | null,
    openOrderCount: number | null,
    message: string
  ): Omit<HedgeModeResult, "mutationsDispatched"> {
    return { outcome, positionModeBefore, positionModeAfter, nonZeroPositionCount, openOrderCount, message };
  }

  private testResult(
    outcome: TestOrderOutcome,
    realOpenOrdersChanged: boolean,
    openOrderCountBefore: number | null,
    openOrderCountAfter: number | null,
    validationViolations: TestOrderValidationCode[],
    clientOrderId: string | null,
    message: string
  ): Omit<TestOrderResult, "mutationsDispatched"> {
    return {
      outcome,
      realOpenOrdersChanged,
      openOrderCountBefore,
      openOrderCountAfter,
      validationViolations,
      clientOrderId,
      message,
    };
  }
}
