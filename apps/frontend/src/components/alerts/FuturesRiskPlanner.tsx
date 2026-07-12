import { useEffect, useMemo, useState } from "react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { tradeReviewsApi } from "../../api/trade-reviews.api";
import { formatPrice } from "../../utils/formatPrice";
import {
  calculateFuturesRiskPlan,
  NON_DIRECTIONAL_PLAN_MESSAGE,
  TRADE_MARGIN_MODES,
  type FuturesRiskPlan,
  type TradeMarginMode,
} from "@trading-alert-dashboard/shared";
import type { Alert } from "../../types/alert";

/** Leverage levels shown in the educational comparison card (spec-defined). */
const COMPARISON_LEVERAGES = ["25", "100"] as const;

const PRICE_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Display-only formatting: stored/calculated values stay exact strings; the
 * Number() conversion here only feeds the shared dynamic price formatter.
 */
function fmt(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return formatPrice(Number(value));
}

function fmtPercent(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Number(value).toFixed(2)}%`;
}

function fmtRatio(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return Number(value).toFixed(2);
}

interface PlannerFields {
  entryPrice: string;
  stopLossPrice: string;
  takeProfitPrice: string;
  liquidationPrice: string;
  accountBalance: string;
  riskPercent: string;
  leverage: string;
  marginMode: TradeMarginMode;
}

export function FuturesRiskPlanner({ alert }: { alert: Alert }) {
  const directional = alert.signal === "LONG" || alert.signal === "SHORT";

  const [fields, setFields] = useState<PlannerFields>({
    entryPrice: "",
    stopLossPrice: "",
    takeProfitPrice: "",
    liquidationPrice: "",
    accountBalance: "",
    riskPercent: "",
    leverage: "",
    marginMode: "ISOLATED",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false); // collapsed by default

  useEffect(() => {
    setLoading(true);
    setError(null);
    tradeReviewsApi
      .getForAlert(alert.id)
      .then((review) => {
        setFields({
          entryPrice: review.entryPrice ?? "",
          stopLossPrice: review.stopLossPrice ?? "",
          takeProfitPrice: review.takeProfitPrice ?? "",
          liquidationPrice: review.liquidationPrice ?? "",
          accountBalance: review.accountBalance ?? "",
          riskPercent: review.riskPercent ?? "",
          leverage: review.leverage ?? "",
          marginMode: review.marginMode ?? "ISOLATED",
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load risk plan"))
      .finally(() => setLoading(false));
  }, [alert.id]);

  function setField<K extends keyof PlannerFields>(key: K, value: PlannerFields[K]) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  const hasAllInputs =
    fields.entryPrice.trim() !== "" &&
    fields.stopLossPrice.trim() !== "" &&
    fields.takeProfitPrice.trim() !== "" &&
    fields.accountBalance.trim() !== "" &&
    fields.riskPercent.trim() !== "" &&
    fields.leverage.trim() !== "";

  // Live plan, recalculated on every keystroke with decimal-safe math.
  const plan: FuturesRiskPlan | null = useMemo(() => {
    if (!directional || !hasAllInputs) return null;
    return calculateFuturesRiskPlan({
      direction: alert.signal as "LONG" | "SHORT",
      entryPrice: fields.entryPrice.trim(),
      stopLossPrice: fields.stopLossPrice.trim(),
      takeProfitPrice: fields.takeProfitPrice.trim(),
      accountBalance: fields.accountBalance.trim(),
      riskPercent: fields.riskPercent.trim(),
      leverage: fields.leverage.trim(),
      marginMode: fields.marginMode,
      liquidationPrice: fields.liquidationPrice.trim() === "" ? null : fields.liquidationPrice.trim(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directional, hasAllInputs, alert.signal, JSON.stringify(fields)]);

  // Educational comparison: same inputs, only leverage swapped.
  const comparison = useMemo(() => {
    if (!plan?.valid) return null;
    return COMPARISON_LEVERAGES.map((lev) => ({
      leverage: lev,
      plan: calculateFuturesRiskPlan({
        direction: alert.signal as "LONG" | "SHORT",
        entryPrice: fields.entryPrice.trim(),
        stopLossPrice: fields.stopLossPrice.trim(),
        takeProfitPrice: fields.takeProfitPrice.trim(),
        accountBalance: fields.accountBalance.trim(),
        riskPercent: fields.riskPercent.trim(),
        leverage: lev,
        marginMode: fields.marginMode,
      }),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.valid, alert.signal, JSON.stringify(fields)]);

  async function save() {
    if (saving) return;

    const priceFields: Array<[string, string]> = [
      ["Entry price", fields.entryPrice],
      ["Stop loss", fields.stopLossPrice],
      ["Take profit", fields.takeProfitPrice],
      ["Liquidation price", fields.liquidationPrice],
      ["Account balance", fields.accountBalance],
      ["Risk percent", fields.riskPercent],
      ["Leverage", fields.leverage],
    ];
    for (const [label, value] of priceFields) {
      if (value.trim() !== "" && !PRICE_PATTERN.test(value.trim())) {
        setError(`${label} must be a plain decimal, e.g. "0.004086"`);
        return;
      }
    }

    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      const toValue = (raw: string) => (raw.trim() === "" ? null : raw.trim());
      const review = await tradeReviewsApi.upsertForAlert(alert.id, {
        entryPrice: toValue(fields.entryPrice),
        stopLossPrice: toValue(fields.stopLossPrice),
        takeProfitPrice: toValue(fields.takeProfitPrice),
        liquidationPrice: toValue(fields.liquidationPrice),
        accountBalance: toValue(fields.accountBalance),
        riskPercent: toValue(fields.riskPercent),
        leverage: toValue(fields.leverage),
        marginMode: fields.marginMode,
      });
      setFields({
        entryPrice: review.entryPrice ?? "",
        stopLossPrice: review.stopLossPrice ?? "",
        takeProfitPrice: review.takeProfitPrice ?? "",
        liquidationPrice: review.liquidationPrice ?? "",
        accountBalance: review.accountBalance ?? "",
        riskPercent: review.riskPercent ?? "",
        leverage: review.leverage ?? "",
        marginMode: review.marginMode ?? "ISOLATED",
      });
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save risk plan");
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-surface-border bg-surface px-2.5 py-1.5 text-sm text-slate-200 focus:border-blue-500 focus:outline-none";
  const labelClass = "mb-1 block text-xs text-slate-500";

  if (loading) {
    return (
      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-200">Futures Risk Planner</h2>
        <p className="text-sm text-slate-500">Loading…</p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">Futures Risk Planner</h2>
        <span className="text-xs text-slate-500">
          Direction: <span className="font-semibold text-slate-200">{alert.signal}</span>
        </span>
      </div>

      <p className="mb-3 text-xs text-slate-500">
        Position size is derived from your risk budget and stop distance — leverage only changes
        the margin required, never the risk taken.
      </p>

      {/* Trade setup */}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <label className={labelClass}>Entry price</label>
          <div className="flex gap-1.5">
            <input
              type="text"
              inputMode="decimal"
              value={fields.entryPrice}
              onChange={(e) => setField("entryPrice", e.target.value)}
              className={inputClass}
            />
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setField("entryPrice", String(alert.price))}
              title="Fill the entry input with the alert's trigger price (nothing is saved until you click Save plan)"
            >
              Use Alert Price
            </Button>
          </div>
        </div>
        <div>
          <label className={labelClass}>Stop loss</label>
          <input type="text" inputMode="decimal" value={fields.stopLossPrice} onChange={(e) => setField("stopLossPrice", e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Take profit</label>
          <input type="text" inputMode="decimal" value={fields.takeProfitPrice} onChange={(e) => setField("takeProfitPrice", e.target.value)} className={inputClass} />
        </div>
        <div className="col-span-2">
          <label className={labelClass}>Exchange liquidation price (optional, copy from exchange)</label>
          <input type="text" inputMode="decimal" value={fields.liquidationPrice} onChange={(e) => setField("liquidationPrice", e.target.value)} className={inputClass} />
        </div>
      </div>

      {/* Money management */}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <div>
          <label className={labelClass}>Account balance</label>
          <input type="text" inputMode="decimal" value={fields.accountBalance} onChange={(e) => setField("accountBalance", e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Risk per trade (%)</label>
          <input type="text" inputMode="decimal" value={fields.riskPercent} onChange={(e) => setField("riskPercent", e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Leverage</label>
          <input type="text" inputMode="decimal" value={fields.leverage} onChange={(e) => setField("leverage", e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Margin mode</label>
          <select
            value={fields.marginMode}
            onChange={(e) => setField("marginMode", e.target.value as TradeMarginMode)}
            className={inputClass}
          >
            {TRADE_MARGIN_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <Button variant="secondary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save plan"}
        </Button>
        {justSaved && <span className="text-xs text-green-400">Saved ✓</span>}
      </div>

      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

      {/* Results */}
      {!directional && (
        <p className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-xs text-slate-400">
          {NON_DIRECTIONAL_PLAN_MESSAGE}
        </p>
      )}

      {directional && !hasAllInputs && (
        <p className="text-xs text-slate-500">
          Enter entry, stop loss, take profit, account balance, risk % and leverage to calculate.
        </p>
      )}

      {plan && !plan.valid && (
        <ul className="list-disc space-y-1 pl-4 text-xs text-red-400">
          {plan.validationErrors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {plan?.valid && (
        <>
          {plan.warnings.length > 0 && (
            <ul className="mb-3 space-y-1.5">
              {plan.warnings.map((warning) => (
                <li
                  key={warning}
                  className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400"
                >
                  {warning}
                </li>
              ))}
            </ul>
          )}

          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Trade summary
          </h3>
          <dl className="mb-3 space-y-1 text-sm">
            <ResultRow label="Maximum loss" value={fmt(plan.riskBudget)} highlight />
            <ResultRow label="Position size (USDT)" value={fmt(plan.positionNotional)} />
            <ResultRow
              label={`Margin needed at ${fields.leverage.trim()}x`}
              value={fmt(plan.requiredMargin)}
            />
            <ResultRow label="Expected profit at TP" value={fmt(plan.expectedProfitAtTakeProfit)} />
            <ResultRow label="R:R ratio" value={fmtRatio(plan.riskRewardRatio)} highlight />
          </dl>

          {/* Technical metrics stay computed by the shared engine/API; they
              are just tucked away from the default view (collapsed). */}
          <div className="mb-3 rounded-lg border border-surface-border bg-surface">
            <button
              type="button"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((prev) => !prev)}
              className="flex w-full items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 transition-colors hover:text-slate-300"
            >
              Advanced details
              <span aria-hidden="true" className="text-sm leading-none">
                {showAdvanced ? "▾" : "▸"}
              </span>
            </button>
            {showAdvanced && (
              <dl className="space-y-1 px-3 pb-3 pt-1 text-sm">
                <ResultRow label="Risk per unit" value={fmt(plan.riskPerUnit)} />
                <ResultRow label="Reward per unit" value={fmt(plan.rewardPerUnit)} />
                <ResultRow label="Position quantity" value={fmt(plan.positionQuantity)} />
                <ResultRow label="Stop distance" value={fmtPercent(plan.stopDistancePercent)} />
                <ResultRow label="Reward percentage" value={fmtPercent(plan.rewardPercent)} />
                <ResultRow label="Margin usage" value={fmtPercent(plan.marginUsagePercent)} />
              </dl>
            )}
          </div>

          {comparison && (
            <div className="rounded-lg border border-surface-border bg-surface p-3">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                Same position at different leverage
              </h3>
              <dl className="mb-2 space-y-1 text-sm">
                {comparison.map(({ leverage, plan: comparePlan }) => (
                  <ResultRow
                    key={leverage}
                    label={`Required margin at ${leverage}x`}
                    value={fmt(comparePlan.requiredMargin)}
                  />
                ))}
                <ResultRow label="Expected loss at SL (both)" value={fmt(plan.riskBudget)} />
                <ResultRow label="Expected profit at TP (both)" value={fmt(plan.expectedProfitAtTakeProfit)} />
              </dl>
              <p className="text-[11px] text-slate-500">
                Changing leverage alone does not change position risk when position notional and
                stop loss remain unchanged. It changes the margin required and liquidation buffer.
              </p>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function ResultRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className={highlight ? "font-semibold text-slate-100" : "text-slate-200"}>{value}</dd>
    </div>
  );
}
