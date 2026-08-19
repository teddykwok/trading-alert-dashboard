import {
  calculateDynamicLeveragePlan,
  estimateIsolatedLiquidationPrice,
  type DynamicLeveragePlan,
  type LiquidationEstimate,
  type MarginPlanLeverageBracket,
} from "@trading-alert-dashboard/shared";
import { env } from "../../config/env";
import { BinanceReadOnlyService } from "./binance-read-only.service";
import type { BinancePositionDto } from "./binance.types";

/**
 * Thin READ-ONLY orchestration around the pure Phase 3 engine.
 *
 * It fetches symbol filters and account leverage brackets through the Phase 2
 * GET-only connector, hands them to the pure calculator, and returns the
 * result. It performs no arithmetic of its own, writes nothing, and exposes
 * no method that could place an order or change leverage, margin type or
 * position mode — the recommendation is presentation-only.
 */

export interface MarginPlanRequest {
  symbol: string;
  direction: "LONG" | "SHORT";
  entryPrice: string;
  stopLoss: string;
  riskBudgetUsd: string;
  /** Local overrides; default to the validated env policy. */
  targetMarginMultiplier?: string;
  maximumMarginMultiplier?: string;
  /** Absolute USD floor; "0" disables it. See BINANCE_MIN_MARGIN_USD. */
  minimumMarginUsd?: string;
  liquidationBufferRatio?: string;
  userMaximumAutomationLeverage?: number;
}

/**
 * Exactly the sanitized symbol filters the Phase 3 calculator consumes —
 * nothing more.
 *
 * Deliberately narrower than `BinanceSymbolFiltersDto`: no raw payload, no
 * leverage brackets, no account configuration, no `symbol` (the execution row
 * already carries it), and none of the MARKET_LOT_SIZE or order-type fields the
 * calculation does not read. What is frozen onto an execution is precisely what
 * decided its numbers.
 */
export interface MarginPlanExchangeFilters {
  status: string | null;
  contractType: string | null;
  tickSize: string | null;
  minPrice: string | null;
  maxPrice: string | null;
  stepSize: string | null;
  minQty: string | null;
  maxQty: string | null;
  minNotional: string | null;
}

/** A plan plus the filter snapshot that produced it, from ONE inspection. */
export interface MarginPlanWithSnapshot {
  plan: DynamicLeveragePlan;
  exchangeFilters: MarginPlanExchangeFilters;
}

export interface LiquidationCheck {
  symbol: string;
  positionSide: string;
  quantity: string | null;
  entryPrice: string | null;
  isolatedWallet: string | null;
  reportedLiquidationPrice: string | null;
  estimate: LiquidationEstimate;
  skippedReason: string | null;
}

export class BinanceMarginPlanService {
  constructor(private readonly readOnly: BinanceReadOnlyService = new BinanceReadOnlyService()) {}

  /**
   * Builds a dynamic-leverage plan for one symbol using live read-only
   * exchange metadata. Two GETs only: exchangeInfo (filters) and
   * leverageBracket (account brackets), both via the Phase 2 allowlist.
   *
   * Unchanged for every caller that only wants the plan; it delegates to the
   * snapshot-aware method below and drops the filters.
   */
  async planForSymbol(request: MarginPlanRequest): Promise<DynamicLeveragePlan> {
    return (await this.planForSymbolWithSnapshot(request)).plan;
  }

  /**
   * The same single planning operation, additionally returning the exact
   * filters it used.
   *
   * The execution path must freeze the filters that produced its numbers, and
   * asking the exchange a second time would not do: between two inspections a
   * tick size or minimum notional can change, and the persisted snapshot would
   * then describe a calculation that never happened. So there is ONE
   * `inspectSymbol` call and ONE projection of its filters, handed both to the
   * calculator and back to the caller — the same object, so the two can never
   * disagree.
   */
  async planForSymbolWithSnapshot(request: MarginPlanRequest): Promise<MarginPlanWithSnapshot> {
    const inspection = await this.readOnly.inspectSymbol(request.symbol);

    const exchangeFilters: MarginPlanExchangeFilters = {
      status: inspection.filters.status,
      contractType: inspection.filters.contractType,
      tickSize: inspection.filters.tickSize,
      minPrice: inspection.filters.minPrice,
      maxPrice: inspection.filters.maxPrice,
      stepSize: inspection.filters.stepSize,
      minQty: inspection.filters.minQty,
      maxQty: inspection.filters.maxQty,
      minNotional: inspection.filters.minNotional,
    };

    const plan = calculateDynamicLeveragePlan({
      symbol: request.symbol.trim().toUpperCase(),
      direction: request.direction,
      entryPrice: request.entryPrice,
      stopLoss: request.stopLoss,
      riskBudgetUsd: request.riskBudgetUsd,
      targetMarginMultiplier: request.targetMarginMultiplier ?? env.BINANCE_TARGET_MARGIN_MULTIPLIER,
      maximumMarginMultiplier: request.maximumMarginMultiplier ?? env.BINANCE_MAX_MARGIN_MULTIPLIER,
      minimumMarginUsd: request.minimumMarginUsd ?? env.BINANCE_MIN_MARGIN_USD,
      liquidationBufferRatio: request.liquidationBufferRatio ?? env.BINANCE_LIQUIDATION_BUFFER_RATIO,
      userMaximumAutomationLeverage:
        request.userMaximumAutomationLeverage ?? env.BINANCE_MAX_AUTOMATION_LEVERAGE,
      filters: exchangeFilters,
      brackets: inspection.brackets satisfies MarginPlanLeverageBracket[],
    });

    return { plan, exchangeFilters };
  }

  /**
   * Compares the engine's liquidation estimate with Binance's own reported
   * liquidation price for the account's existing ISOLATED positions.
   *
   * CROSS positions are skipped (the estimator models isolated margin only),
   * as are zero-size positions and any position missing the inputs the
   * formula requires. Read-only throughout.
   */
  async checkLiquidationEstimates(): Promise<LiquidationCheck[]> {
    const summary = await this.readOnly.getAccountSummary();
    const checks: LiquidationCheck[] = [];

    for (const position of summary.positions) {
      const base = {
        symbol: position.symbol,
        positionSide: position.positionSide,
        quantity: position.positionAmt,
        entryPrice: position.entryPrice,
        isolatedWallet: position.isolatedWallet,
        reportedLiquidationPrice: position.liquidationPrice,
      };

      const skip = this.skipReasonFor(position);
      if (skip) {
        checks.push({
          ...base,
          estimate: { available: false, price: null, bracket: null, unavailableReason: skip },
          skippedReason: skip,
        });
        continue;
      }

      const inspection = await this.readOnly.inspectSymbol(position.symbol);
      checks.push({
        ...base,
        estimate: estimateIsolatedLiquidationPrice({
          direction: position.positionSide === "SHORT" ? "SHORT" : "LONG",
          quantity: position.positionAmt as string,
          entryPrice: position.entryPrice as string,
          isolatedWallet: position.isolatedWallet as string,
          brackets: inspection.brackets satisfies MarginPlanLeverageBracket[],
        }),
        skippedReason: null,
      });
    }

    return checks;
  }

  /** Why a live position cannot be used to validate the isolated estimator. */
  private skipReasonFor(position: BinancePositionDto): string | null {
    if (position.marginType === "CROSS") return "CROSS position (estimator models ISOLATED margin only)";
    if (position.marginType === null) return "margin type unknown";
    if (position.positionSide === "BOTH") return "one-way BOTH position side";
    if (!position.positionAmt || !/[1-9]/.test(position.positionAmt)) return "zero position size";
    if (!position.entryPrice || !position.isolatedWallet) return "missing entry price or isolated wallet";
    if (!position.liquidationPrice || !/[1-9]/.test(position.liquidationPrice)) {
      return "Binance reported no liquidation price";
    }
    return null;
  }
}
