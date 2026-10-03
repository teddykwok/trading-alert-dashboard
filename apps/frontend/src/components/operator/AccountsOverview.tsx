import { OPERATOR_ACCOUNTS, OPERATOR_ACCOUNT_LABELS, type AccountOverviewState } from "../../api/operator-account";
import { useAccountsOverview } from "../../hooks/useAccountsOverview";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";

const PRESENTED: Record<AccountOverviewState, { label: string; tone: "green" | "yellow" | "red" | "gray" }> = {
  ONLINE: { label: "ONLINE", tone: "green" },
  AUTH_NEEDED: { label: "AUTH NEEDED", tone: "yellow" },
  OFFLINE: { label: "OFFLINE", tone: "red" },
  UNKNOWN: { label: "UNKNOWN", tone: "gray" },
};

/**
 * Both accounts at a glance — READ ONLY.
 *
 * It shows liveness and whether this tab is signed in to each account. It has
 * no buttons: every control acts on the ONE selected account in Trading
 * Control, never on both.
 */
export function AccountsOverview() {
  const states = useAccountsOverview();
  return (
    <Card className="space-y-2 p-4" data-testid="accounts-overview">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Accounts (read-only)</h2>
      <dl className="space-y-1 text-sm">
        {OPERATOR_ACCOUNTS.map((account) => (
          <div key={account} className="flex items-center justify-between">
            <dt className="text-slate-400">{OPERATOR_ACCOUNT_LABELS[account]}</dt>
            <dd>
              <Badge tone={PRESENTED[states[account]].tone}>{PRESENTED[states[account]].label}</Badge>
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
