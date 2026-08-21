import { useState, type FormEvent, type ReactNode } from "react";

import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { classNames } from "../../utils/classNames";
import { useTradingControl } from "../../hooks/useTradingControl";
import type { TradingControlReadinessSnapshot, TradingControlStatusDto } from "../../api/operator";
import {
  presentAllowedSymbols,
  presentAttestation,
  presentAuthorization,
  presentBlockers,
  presentCapacity,
  presentLatestExecution,
  presentReadinessSnapshot,
  presentReservation,
  presentRuntime,
  presentSystemState,
} from "../../features/operator/tradingControlPresentation";
import {
  TRADING_CONTROL_ACTIONS,
  describeStartContext,
  describeStartPrerequisite,
  isActionRelevant,
  isConfirmationSatisfied,
  presentActionResult,
  type TradingControlAction,
} from "../../features/operator/tradingControlActions";

/**
 * The operator's Trading Control panel. READ ONLY.
 *
 * Nothing on this card is decided here: the system state, the readiness verdict
 * and the blocker text all come from the backend services that already own
 * them, and every display choice comes from `tradingControlPresentation`. This
 * file is the thin mapping between the two.
 */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs uppercase tracking-wide text-slate-400">{label}</span>
      <span className="text-sm text-slate-200">{children}</span>
    </div>
  );
}

function OperatorTokenForm({
  onSubmit,
  busy,
  error,
}: {
  onSubmit: (token: string) => void;
  busy: boolean;
  error: string | null;
}) {
  // The only place the raw token exists in component-land, and it is cleared
  // the moment it is handed over. It is never lifted into a parent, a context
  // or the URL.
  const [value, setValue] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim().length === 0) return;
    onSubmit(value);
    setValue("");
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor="operator-token" className="block text-xs uppercase tracking-wide text-slate-400">
        Operator Token
      </label>
      <input
        id="operator-token"
        // `password` so it is masked, and autoComplete off so no browser
        // password manager is offered a chance to persist it.
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Enter operator token"
        className="w-full rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-sm text-slate-200"
      />
      <p className="text-xs text-slate-500">
        Held in memory only. A page refresh requires re-entry, which is intentional.
      </p>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      <Button type="submit" disabled={busy || value.trim().length === 0}>
        {busy ? "Checking…" : "Authenticate"}
      </Button>
    </form>
  );
}

function StatusBody({
  status,
  readiness,
}: {
  status: TradingControlStatusDto;
  readiness: TradingControlReadinessSnapshot | null;
}) {
  const { capacity, reservations, runtimeAttestation } = status;
  const system = presentSystemState(status.systemState);
  const runtime = presentRuntime(runtimeAttestation);
  const attestation = presentAttestation(runtimeAttestation);
  // Readiness comes from the last EXPLICIT check, never from the poll, so it
  // reads "Not checked yet" until the operator asks.
  const preparation = presentReadinessSnapshot(readiness, "PREPARATION");
  const activation = presentReadinessSnapshot(readiness, "LIVE_ACTIVATION");
  const authorization = presentAuthorization(status.authorization);
  const blockers = readiness ? presentBlockers(readiness) : [];

  return (
    <div className="space-y-3">
      {status.warnings.length > 0 ? (
        <ul className="space-y-1 rounded-lg border border-red-500/30 bg-red-500/10 p-2">
          {status.warnings.map((warning) => (
            <li key={warning.code} className="text-xs text-red-300">
              <span className="font-semibold">{warning.code}</span> — {warning.detail}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="divide-y divide-surface-border/60">
        <Row label="System">
          <Badge tone={system.tone}>{system.label}</Badge>
        </Row>
        <Row label="Runtime">
          <Badge tone={runtime.tone}>{runtime.label}</Badge>
        </Row>
        <Row label="Attestation">
          <Badge tone={attestation.tone}>{attestation.label}</Badge>
        </Row>
        <Row label="Preparation">
          <Badge tone={preparation.tone}>{preparation.label}</Badge>
        </Row>
        <Row label="Live Activation">
          <Badge tone={activation.tone}>{activation.label}</Badge>
        </Row>
        <Row label="Allowed Symbols">{presentAllowedSymbols(status.allowedSymbols)}</Row>
        <Row label="Natural Window">{authorization.state}</Row>
        <Row label="TTL">{authorization.ttl}</Row>
        <Row label="Claims">{authorization.claims}</Row>
        <Row label="Active">{presentCapacity(capacity)}</Row>
        <Row label="Risk">{presentReservation(reservations.riskUsd, reservations.riskLimitUsd)}</Row>
        <Row label="Margin">{presentReservation(reservations.marginUsd, reservations.marginLimitUsd)}</Row>
        <Row label="Latest Execution">{presentLatestExecution(status.latestExecution)}</Row>
      </div>

      {blockers.length > 0 && (
        <details className="rounded-lg border border-surface-border p-2">
          <summary className="cursor-pointer text-xs uppercase tracking-wide text-slate-400">
            Blockers ({blockers.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {blockers.map((finding) => (
              <li key={`${finding.scope}:${finding.code}:${finding.detail}`} className="text-xs text-slate-400">
                <span className="font-semibold text-slate-300">{finding.scope}</span> [{finding.code}] {finding.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * The confirmation step.
 *
 * Start Trading demands the phrase typed exactly, because it is the one action
 * that opens a real-money account to admission. The server re-checks the same
 * phrase, so this is friction for the operator's benefit, never the boundary.
 *
 * The context shown is entirely read from the authoritative status: none of it
 * is editable, because risk, margin, capacity and the symbol allowlist are
 * server-side policy.
 */
function ConfirmDialog({
  action,
  status,
  pending,
  onCancel,
  onConfirm,
}: {
  action: TradingControlAction;
  status: TradingControlStatusDto | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (phrase: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const context = status ? describeStartContext(status) : null;
  const satisfied = isConfirmationSatisfied(action, typed);

  return (
    <div className="space-y-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3">
      <p className="text-sm font-semibold text-slate-100">{action.label}</p>
      <p className="text-xs text-slate-300">{action.description}</p>

      {action.id === "START" && context ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-slate-400">
          <dt>Environment</dt>
          <dd className="text-slate-200">{context.environment}</dd>
          <dt>Allowed symbols</dt>
          <dd className="text-slate-200">{context.allowedSymbols}</dd>
          <dt>Risk</dt>
          <dd className="text-slate-200">{context.riskLimit}</dd>
          <dt>Margin</dt>
          <dd className="text-slate-200">{context.marginLimit}</dd>
          <dt>Desired open</dt>
          <dd className="text-slate-200">{context.desiredOpen}</dd>
          <dt>Hard active limit</dt>
          <dd className="text-slate-200">{context.hardTotal}</dd>
          <dt>Max claims</dt>
          <dd className="text-slate-200">{context.maxClaims}</dd>
          <dt>Window</dt>
          <dd className="text-slate-200">{context.windowMinutes} minutes</dd>
        </dl>
      ) : null}

      {action.requiredPhrase ? (
        <label className="block space-y-1">
          <span className="text-xs text-slate-400">
            Type <span className="font-mono text-slate-200">{action.requiredPhrase}</span> to continue
          </span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-sm text-slate-200"
          />
        </label>
      ) : null}

      <div className="flex gap-2">
        <Button
          variant={action.destructiveLooking ? "danger" : "primary"}
          disabled={!satisfied || pending}
          onClick={() => onConfirm(typed)}
        >
          {pending ? "Working…" : `Confirm ${action.label}`}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function TradingControlCard() {
  const {
    authState,
    authError,
    status,
    statusError,
    loading,
    readiness,
    readinessError,
    checkingReadiness,
    authenticate,
    signOut,
    refresh,
    checkReadiness,
    pendingAction,
    actionResult,
    actionError,
    runAction,
    dismissActionResult,
  } = useTradingControl();
  const [confirming, setConfirming] = useState<TradingControlAction | null>(null);
  // Read from the polled status the server already sends; nothing extra is
  // fetched and no readiness check is triggered.
  const startPrerequisite = describeStartPrerequisite(status);

  return (
    <Card className="space-y-3 p-4" data-testid="trading-control-card">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Trading Control</h2>
        <Badge tone={authState === "AUTHENTICATED" ? "green" : "gray"}>
          {authState === "AUTHENTICATED" ? "Authenticated" : "Not Authenticated"}
        </Badge>
      </div>

      {authState === "AUTHENTICATED" ? (
        <>
          {status ? (
            <StatusBody status={status} readiness={readiness} />
          ) : (
            <p className="text-sm text-slate-400">Loading status…</p>
          )}
          {statusError ? <p className="text-xs text-red-400">{statusError}</p> : null}
          {readinessError ? <p className="text-xs text-red-400">{readinessError}</p> : null}

          <div className="flex flex-wrap gap-2 pt-1">
            {/* The only control that can cost a signed exchange read, so it is
                a button and never a timer. */}
            <Button variant="secondary" onClick={() => void checkReadiness()} disabled={checkingReadiness}>
              {checkingReadiness ? "Checking…" : "Check Readiness"}
            </Button>
            <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh status"}
            </Button>
            <Button variant="ghost" onClick={signOut}>
              Sign out
            </Button>
          </div>

          {confirming ? (
            <ConfirmDialog
              action={confirming}
              status={status}
              pending={pendingAction !== null}
              onCancel={() => setConfirming(null)}
              onConfirm={(phrase) => {
                const action = confirming;
                setConfirming(null);
                void runAction(action.id, phrase);
              }}
            />
          ) : null}

          {actionResult ? (
            (() => {
              const presented = presentActionResult(actionResult);
              return (
                <div
                  className={classNames(
                    "space-y-1 rounded-lg border p-2",
                    presented.tone === "green"
                      ? "border-green-500/30 bg-green-500/10"
                      : presented.tone === "yellow"
                        ? "border-yellow-500/30 bg-yellow-500/10"
                        : "border-red-500/30 bg-red-500/10"
                  )}
                >
                  <p className="text-xs font-semibold text-slate-200">{presented.headline}</p>
                  {presented.detail.map((line) => (
                    <p key={line} className="text-xs text-slate-300">
                      {line}
                    </p>
                  ))}
                  <button type="button" onClick={dismissActionResult} className="text-xs text-slate-500 underline">
                    Dismiss
                  </button>
                </div>
              );
            })()
          ) : null}
          {actionError ? <p className="text-xs text-red-400">{actionError}</p> : null}

          <div className="space-y-2 border-t border-surface-border pt-2">
            {/* The deployment prerequisite, stated BEFORE the operator can form
                the belief that Start alone brings the runtime up live. */}
            {startPrerequisite.reason ? (
              <p className="rounded-lg border border-slate-500/30 bg-slate-500/10 p-2 text-xs text-slate-300">
                {startPrerequisite.reason}
              </p>
            ) : null}
            {startPrerequisite.warning ? (
              <p className="text-xs text-yellow-400">{startPrerequisite.warning}</p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {TRADING_CONTROL_ACTIONS.map((action) => {
                const relevant = status ? isActionRelevant(action.id, status.systemState) : false;
                // Start additionally needs the deployment prerequisite. Stop and
                // Safe Off do NOT: they only ever reduce risk, and must stay
                // reachable no matter what state the runtime is in.
                const eligible = relevant && (action.id !== "START" || startPrerequisite.ready);
                return (
                  <Button
                    key={action.id}
                    variant={action.destructiveLooking ? "danger" : "secondary"}
                    // Disabled while ANY action is in flight: a second submission
                    // is pointless, and the server serializes them anyway.
                    disabled={!eligible || pendingAction !== null}
                    onClick={() => setConfirming(action)}
                    title={
                      !relevant
                        ? "Not applicable in the current system state."
                        : !eligible
                          ? (startPrerequisite.reason ?? action.description)
                          : action.description
                    }
                  >
                    {pendingAction === action.id ? `${action.label}…` : action.label}
                  </Button>
                );
              })}
            </div>
          </div>
        </>
      ) : (
        <OperatorTokenForm
          onSubmit={(token) => void authenticate(token)}
          busy={authState === "AUTHENTICATING"}
          error={authError}
        />
      )}
    </Card>
  );
}
