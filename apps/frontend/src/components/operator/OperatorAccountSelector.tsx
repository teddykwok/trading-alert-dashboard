import { OPERATOR_ACCOUNTS, OPERATOR_ACCOUNT_LABELS } from "../../api/operator-account";
import { selectOperatorAccount } from "../../features/operator/operatorAccountSelection";
import { useSelectedOperatorAccount } from "../../hooks/useSelectedOperatorAccount";
import { classNames } from "../../utils/classNames";

/**
 * The ONE place the operator chooses which account Trading Control targets.
 *
 * Exactly two choices, Account A and Account B. There is no "All" choice and no
 * default: until one is picked the header says so and Trading Control offers
 * nothing. The choice is presentation state only — each account keeps its own
 * control plane, credentials, worker and gates.
 */
export function OperatorAccountSelector() {
  const selected = useSelectedOperatorAccount();
  return (
    <div className="flex items-center gap-2 text-xs" role="group" aria-label="Operator account" data-testid="operator-account-selector">
      <span className="text-slate-400">Account:</span>
      {OPERATOR_ACCOUNTS.map((account) => (
        <button
          key={account}
          type="button"
          aria-pressed={selected === account}
          onClick={() => selectOperatorAccount(account)}
          className={classNames(
            "rounded-md border px-2 py-1",
            selected === account ? "border-blue-500 bg-blue-500/20 text-slate-100" : "border-surface-border text-slate-400 hover:text-slate-200"
          )}
        >
          {OPERATOR_ACCOUNT_LABELS[account]}
        </button>
      ))}
      {selected === null ? <span className="text-yellow-400">none selected</span> : null}
    </div>
  );
}
