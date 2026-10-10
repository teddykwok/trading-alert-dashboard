import { OPERATOR_ACCOUNT_LABELS } from "../api/operator-account";
import { AccountsOverview } from "../components/operator/AccountsOverview";
import { HistoricalFillOperationsCard } from "../components/operator/HistoricalFillOperationsCard";
import { NativePlansCard } from "../components/operator/NativePlansCard";
import { OperatorAccountSelector } from "../components/operator/OperatorAccountSelector";
import { TradingControlCard } from "../components/operator/TradingControlCard";
import { Card } from "../components/ui/Card";
import { useSelectedOperatorAccount } from "../hooks/useSelectedOperatorAccount";

/**
 * The operator's Trading Control page — for exactly ONE selected account.
 *
 * The account is chosen in the header (and here). Until one is chosen, nothing
 * account-scoped is fetched and no control is offered. Each account-scoped card
 * is keyed by the account, so switching A -> B (or back) remounts it from a
 * clean slate: no status, readiness, pending action, form input or late
 * response from the previous account can carry over. The overview above them
 * is read-only and shows both accounts.
 *
 * The account controls stay in the narrow column. Only the read-only Native
 * plan section is wide, because it is a monitoring table, not a control.
 */
export function TradingControlPage() {
  const account = useSelectedOperatorAccount();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex max-w-2xl flex-col gap-4">
        <header className="space-y-2">
          <h1 className="text-lg font-semibold text-slate-100">Trading Control</h1>
          <p className="text-sm text-slate-400">
            Operator-only view of live trading state, the supervised activation controls, and the
            durable symbol allowlist — for one account at a time.
          </p>
          <OperatorAccountSelector />
        </header>

        <AccountsOverview />
      </div>

      {/* Read-only and not account-scoped: no account can execute a Native plan. */}
      <div className="min-w-0 max-w-[96rem]">
        <NativePlansCard />
      </div>

      <div className="flex max-w-2xl flex-col gap-4">
        {account === null ? (
          <Card className="p-4" data-testid="trading-control-no-account">
            <p className="text-sm text-slate-300">Select Account A or Account B to use Trading Control.</p>
            <p className="text-xs text-slate-500">Every control acts on exactly one account. There is no all-accounts action.</p>
          </Card>
        ) : (
          <>
            <p className="text-xs text-slate-500" data-testid="trading-control-target">
              Every request below targets {OPERATOR_ACCOUNT_LABELS[account]} only.
            </p>
            <TradingControlCard key={`trading-control-${account}`} account={account} />
            {/* Read-only durable fill-ingestion state for the same account. */}
            <HistoricalFillOperationsCard key={`historical-fills-${account}`} account={account} />
          </>
        )}
      </div>
    </div>
  );
}
