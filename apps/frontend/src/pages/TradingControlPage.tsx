import { TradingControlCard } from "../components/operator/TradingControlCard";

/**
 * The operator's Trading Control page.
 *
 * Nothing but a home for the existing card: the operator session, status
 * polling, explicit readiness check and every safety decision continue to live
 * in `TradingControlCard` and the modules behind it. Giving it its own route
 * only means it is no longer competing for attention with the alert feed.
 *
 * Width is constrained the way Settings is, because this is a focused operator
 * surface rather than a wide monitoring view — the card is unchanged.
 */
export function TradingControlPage() {
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">Trading Control</h1>
        <p className="text-sm text-slate-400">
          Operator-only view of live trading state. This page is read-only; trading actions are not
          enabled yet.
        </p>
      </header>

      <TradingControlCard />
    </div>
  );
}
