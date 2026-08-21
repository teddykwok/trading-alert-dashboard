import { useState, type FormEvent, type ReactNode } from "react";

import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { useTradingControl } from "../../hooks/useTradingControl";
import type { TradingControlReadinessSnapshot, TradingControlStatusDto } from "../../api/operator";
import {
  LOCKED_ACTIONS,
  LOCKED_ACTION_HINT,
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
  } = useTradingControl();

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

          <div className="flex flex-wrap gap-2 border-t border-surface-border pt-2">
            {LOCKED_ACTIONS.map((action) => (
              <Button key={action.label} variant="secondary" disabled={action.disabled} title={action.hint}>
                {action.label} 🔒
              </Button>
            ))}
          </div>
          <p className="text-xs text-slate-500">{LOCKED_ACTION_HINT}</p>
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
