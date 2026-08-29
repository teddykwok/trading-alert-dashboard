import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { AllowedSymbolsEditor } from "./AllowedSymbolsEditor";
import { TradingPolicyEditor } from "./TradingPolicyEditor";
import { SourceTimeframesEditor } from "./SourceTimeframesEditor";
import { RrLookbackEditor } from "./RrLookbackEditor";
import { classNames } from "../../utils/classNames";
import { useTradingControl } from "../../hooks/useTradingControl";
import {
  START_TRADING_DURATION_CHOICES,
  START_TRADING_BUDGET_CHOICES,
  fetchSessionCapability,
  type SessionCapabilityDto,
  type StartTradingDuration,
  type TradingControlReadinessSnapshot,
  type TradingControlStatusDto,
} from "../../api/operator";
import {
  formatAlertAgeLimit,
  presentAllowedSymbols,
  presentAttestation,
  presentAuthorization,
  presentBlockers,
  presentCapacity,
  presentExecutionReason,
  presentLatestExecution,
  presentOpenCapacity,
  presentPendingCapacity,
  presentReadinessSnapshot,
  presentReservation,
  presentRuntime,
  presentSystemState,
} from "../../features/operator/tradingControlPresentation";
import {
  START_WINDOW_MINUTES,
  TRADING_CONTROL_ACTIONS,
  describeStartContext,
  describeSourceTimeframes,
  describeRrLookback,
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
      <span className="min-w-0 text-right text-sm text-slate-200">{children}</span>
    </div>
  );
}

/**
 * One labelled group of rows.
 *
 * The panel had grown to sixteen visually identical rows, which made state,
 * policy, capacity and outcome all read at the same weight — everything
 * equally important is the same as nothing being important. Grouping restores
 * the order an operator actually asks in: is it safe, is it healthy, what is
 * the policy, how much is used, what happened last.
 *
 * The heading is deliberately quieter than the values inside it: a section
 * label must never compete with SAFE OFF or BLOCKED for attention.
 */
/** Selected / unselected choice-button styling, named so the JSX stays readable. */
const CHOICE_ON =
  "rounded-lg border border-yellow-400/60 bg-yellow-500/20 px-3 py-1 text-xs text-slate-100";
const CHOICE_OFF = "rounded-lg border border-surface-border px-3 py-1 text-xs text-slate-400";

/**
 * A duration in operator units.
 *
 * Sessions are now hours long, and "1440 min" is a number an operator has to
 * decode. Exact minutes are kept for anything that is not a whole hour, so a
 * custom 90 reads as "90 min" rather than being rounded into a lie.
 */
export function formatSessionDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return `${minutes} min`;
  if (minutes % 60 !== 0) return `${minutes} min`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** Whole seconds as `17h 42m`, or `0m` once a session has ended. */
export function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Session progress, in the operator's terms.
 *
 * `Opened` is trades that actually obtained exposure — which is what the
 * budget counts and what CLAIMS never did. Unlimited renders as a word, never
 * as a number, because there is no denominator to show.
 */
export function presentSessionProgress(session: {
  openedCount: number;
  tradeBudget: number | null;
  unlimited: boolean;
}): string {
  return session.unlimited || session.tradeBudget === null
    ? `${session.openedCount}`
    : `${session.openedCount} / ${session.tradeBudget}`;
}

export function presentSessionRemaining(session: {
  remaining: number | null;
  unlimited: boolean;
}): string {
  return session.unlimited || session.remaining === null ? "Unlimited" : String(session.remaining);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-0.5">
      <h3 className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{title}</h3>
      <div className="divide-y divide-surface-border/60">{children}</div>
    </section>
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
  const executionReason = presentExecutionReason(status.latestExecution, status.alertAgeLimitSeconds);

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

      <div className="space-y-3">
        <Section title="System">
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
        </Section>

        <Section title="Trading Policy">
          <Row label="Allowed Symbols">{presentAllowedSymbols(status.allowedSymbols)}</Row>
          <Row label="Source TFs">
            <span className={status.sourceTimeframes.valid ? undefined : "text-red-300"}>
              {describeSourceTimeframes(status.sourceTimeframes)}
            </span>
          </Row>
          <Row label="RR lookback">
            <span className={status.rrLookback.valid ? undefined : "text-red-300"}>
              {describeRrLookback(status.rrLookback)}
            </span>
          </Row>
          {/*
            POLICY only. This is the maximum age a signal may have and still be
            admitted — it is NOT a reading of how old anything was, and it is
            deliberately not labelled "signal age" or "touch time". What the
            backend measures that age from is under separate review, so naming
            it here would assert a meaning the data has not been shown to have.
          */}
          <Row label="Alert Age Limit">{formatAlertAgeLimit(status.alertAgeLimitSeconds)}</Row>
        </Section>

        <Section title="Authorization">
          <Row label="Natural Window">{authorization.state}</Row>
          <Row label="TTL">{authorization.ttl}</Row>
        </Section>

        {/* CUMULATIVE session accounting, deliberately its own section.
            "Opened" counts trades that actually obtained exposure, which is
            what the budget bounds — and what CLAIMS never measured. Kept apart
            from Current Exposure because one is a running total and the other
            is a fact about right now. */}
        {status.session ? (
          <Section title="Session">
            <Row label="Status">{status.session.status}</Row>
            <Row label="Time remaining">
              {formatRemaining(status.session.remainingTtlSeconds)}
            </Row>
            <Row label="Opened">{presentSessionProgress(status.session)}</Row>
            <Row label="Reserved">{status.session.reservedCount}</Row>
            <Row label="Remaining">{presentSessionRemaining(status.session)}</Row>
          </Section>
        ) : null}

        {/* OBSERVED facts, every one counted from execution rows. Read-only by
            construction: there is no control here and no endpoint behind one
            that could set a count, a reservation or a claim. */}
        <Section title="Current Exposure">
          <Row label="Open">{presentOpenCapacity(capacity)}</Row>
          <Row label="Pending">{presentPendingCapacity(capacity)}</Row>
          <Row label="Active">{presentCapacity(capacity)}</Row>
          <Row label="Risk">{presentReservation(reservations.riskUsd, reservations.riskLimitUsd)}</Row>
          <Row label="Margin">{presentReservation(reservations.marginUsd, reservations.marginLimitUsd)}</Row>
        </Section>

        {/* Authorization internals, and labelled as such.
            This row used to read "Claims 5 / 5" beside the exposure counts,
            where it looked like trade progress — and it never was: a claim is
            spent at ADMISSION and is never refunded, so an entry that never
            filled still burned one. Session > Opened is the operator-facing
            progress now; this stays only as low-level evidence of the
            authorization window, under a heading that says so. */}
        <Section title="Authorization (internal)">
          <Row label="Window claims">{authorization.claims}</Row>
        </Section>

        {/* The LIMITS those facts are measured against. Editable only while the
            server says the system is SAFE OFF and quiet — the panel asks, it
            never decides. */}
        <Section title="Policy Limits">
          <TradingPolicyEditor />
        </Section>

        <Section title="Latest Execution">
          <Row label="Outcome">
            <span className="flex flex-col items-end gap-0.5">
              <span>{presentLatestExecution(status.latestExecution)}</span>
              {executionReason && (
                // Secondary by design: the symbol and status stay the thing you
                // scan for, and the explanation sits under them. `title` keeps
                // the raw code one hover away without putting jargon on the card.
                <span
                  className="text-xs font-normal leading-snug text-slate-400"
                  title={status.latestExecution?.reason ?? undefined}
                >
                  Reason: {executionReason}
                </span>
              )}
            </span>
          </Row>
        </Section>
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
  onConfirm: (
    phrase: string,
    durationMinutes: number,
    tradeBudget: number | undefined,
    unlimited: boolean
  ) => void;
}) {
  const [typed, setTyped] = useState("");
  const [duration, setDuration] = useState<number>(START_WINDOW_MINUTES);
  const [customDuration, setCustomDuration] = useState("");
  const [budget, setBudget] = useState<number>(START_TRADING_BUDGET_CHOICES[0]);
  const [customBudget, setCustomBudget] = useState("");
  const [unlimited, setUnlimited] = useState(false);
  const [capability, setCapability] = useState<SessionCapabilityDto | null>(null);
  const context = status ? describeStartContext(status) : null;

  // The SERVER's own answer about what may be offered. Asked once when the
  // dialog opens; a failure leaves it null, which HIDES Unlimited — the safe
  // direction, because the panel must never enable it on a guess.
  useEffect(() => {
    if (action.id !== "START") return undefined;
    let cancelled = false;
    void fetchSessionCapability()
      .then((next) => {
        if (!cancelled) setCapability(next);
      })
      .catch(() => {
        if (!cancelled) setCapability(null);
      });
    return () => {
      cancelled = true;
    };
  }, [action.id]);

  // A custom value wins over the preset when it parses. The SERVER validates
  // whatever is sent, so this only decides what gets sent.
  const parsedDuration = Number(customDuration);
  const resolvedDuration =
    customDuration !== "" && Number.isFinite(parsedDuration) ? parsedDuration : duration;
  const parsedBudget = Number(customBudget);
  const resolvedBudget =
    customBudget !== "" && Number.isFinite(parsedBudget) ? parsedBudget : budget;
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
          <dd className="text-slate-200">
            {context.allowedSymbolCount === 0
              ? context.allowedSymbols
              : `${context.allowedSymbolCount}: ${context.allowedSymbolsPreview}`}
          </dd>
          <dt>Source TFs</dt>
          {/* The PERSISTED policy, never an unsaved draft from the editor
              below: this dialog is where the operator confirms what the
              backend will actually enforce. */}
          <dd className={context.sourceTimeframesValid ? "text-slate-200" : "text-red-300"}>
            {context.sourceTimeframes}
          </dd>
          <dt>RR lookback</dt>
          {/* The PERSISTED policy, never an unsaved draft from the editor
              below: this dialog is where the operator confirms what NEW plans
              will actually be built from. */}
          <dd className={context.rrLookbackValid ? "text-slate-200" : "text-red-300"}>
            {context.rrLookback}
          </dd>
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
          <dd className="text-slate-200">{duration} minutes</dd>
        </dl>
      ) : null}

      {action.id === "START" ? (
        <>
          <fieldset className="space-y-1">
            <legend className="text-xs text-slate-400">Duration</legend>
            <div className="flex flex-wrap gap-2">
              {START_TRADING_DURATION_CHOICES.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  onClick={() => {
                    setDuration(minutes);
                    setCustomDuration("");
                  }}
                  disabled={pending}
                  aria-pressed={customDuration === "" && duration === minutes}
                  className={customDuration === "" && duration === minutes ? CHOICE_ON : CHOICE_OFF}
                >
                  {formatSessionDuration(minutes)}
                </button>
              ))}
              <input
                aria-label="Custom duration in minutes"
                placeholder="Custom min"
                value={customDuration}
                inputMode="numeric"
                disabled={pending}
                onChange={(event) => setCustomDuration(event.target.value)}
                className="w-28 rounded-lg border border-surface-border bg-surface px-2 py-1 text-xs text-slate-200"
              />
            </div>
          </fieldset>

          <fieldset className="space-y-1">
            <legend className="text-xs text-slate-400">
              Trade budget - trades that actually open
            </legend>
            <div className="flex flex-wrap gap-2">
              {START_TRADING_BUDGET_CHOICES.map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => {
                    setBudget(count);
                    setCustomBudget("");
                    setUnlimited(false);
                  }}
                  disabled={pending}
                  aria-pressed={!unlimited && customBudget === "" && budget === count}
                  className={
                    !unlimited && customBudget === "" && budget === count ? CHOICE_ON : CHOICE_OFF
                  }
                >
                  {count}
                </button>
              ))}
              <input
                aria-label="Custom trade budget"
                placeholder="Custom"
                value={customBudget}
                inputMode="numeric"
                disabled={pending || unlimited}
                onChange={(event) => {
                  setCustomBudget(event.target.value);
                  setUnlimited(false);
                }}
                className="w-24 rounded-lg border border-surface-border bg-surface px-2 py-1 text-xs text-slate-200"
              />
              {/* Offered ONLY when the server says so. The panel renders the
                  server's answer and never decides that "paper" means
                  unlimited is safe, so a live account never sees this. */}
              {capability?.unlimitedPermitted ? (
                <button
                  type="button"
                  onClick={() => {
                    setUnlimited(true);
                    setCustomBudget("");
                  }}
                  disabled={pending}
                  aria-pressed={unlimited}
                  className={unlimited ? CHOICE_ON : CHOICE_OFF}
                >
                  Unlimited
                </button>
              ) : null}
            </div>
            {capability && !capability.unlimitedPermitted ? (
              <p className="text-[11px] text-slate-500" data-testid="unlimited-blocked">
                {capability.reason}
              </p>
            ) : null}
          </fieldset>

          {/* Review: the values about to be sent, beside the standing policy
              they will run under. Displayed, never edited - the Policy Editor
              owns those and is SAFE-only. */}
          <dl
            className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded border border-surface-border p-2 text-xs text-slate-400"
            data-testid="start-review"
          >
            <dt>Duration</dt>
            <dd className="text-slate-200">{formatSessionDuration(resolvedDuration)}</dd>
            <dt>Trade budget</dt>
            <dd className="text-slate-200">
              {unlimited ? "Unlimited" : `${resolvedBudget} opened trades`}
            </dd>
            <dt>Max active</dt>
            <dd className="text-slate-200">{context ? context.hardTotal : "-"}</dd>
            <dt>Max risk</dt>
            <dd className="text-slate-200">{context ? context.riskLimit : "-"}</dd>
          </dl>
        </>
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
          onClick={() => onConfirm(typed, resolvedDuration, unlimited ? undefined : resolvedBudget, unlimited)}
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
              onConfirm={(phrase, durationMinutes, tradeBudget, unlimited) => {
                const action = confirming;
                setConfirming(null);
                void runAction(action.id, phrase, durationMinutes, tradeBudget, unlimited);
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

          {/* The durable allowlist. Its own guards are enforced server-side;
              this only decides what is offered. */}
          <AllowedSymbolsEditor status={status} onSaved={() => void refresh()} />

          {/* Execution eligibility by signal SOURCE timeframe. Same durable
              SAFE_OFF guard as the allowlist, enforced server-side. */}
          <SourceTimeframesEditor status={status} onSaved={() => void refresh()} />

          {/* The candle window NEW Extreme RR plans start on. Same durable
              SAFE_OFF guard, enforced server-side. */}
          <RrLookbackEditor status={status} onSaved={() => void refresh()} />
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
