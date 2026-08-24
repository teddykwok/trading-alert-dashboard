import { useEffect, useState } from "react";

import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import {
  postRrLookback,
  type RrLookbackSaveDto,
  type TradingControlStatusDto,
} from "../../api/operator";
import { hasOperatorToken } from "../../api/operator-token";
import {
  canEditRrLookback,
  canSaveRrLookback,
  describeRrLookback,
} from "../../features/operator/tradingControlActions";

/**
 * The operator's Extreme RR lookback selector.
 *
 * The value chooses how many closed candles a NEW plan searches for its
 * extreme — the highest high for a LONG, the lowest low for a SHORT. It is the
 * INITIAL selection for a new plan and nothing more: every supported lookback
 * is still calculated and frozen on every plan, the per-alert planner can still
 * switch between them, and a plan that already exists keeps the window it was
 * built under.
 *
 * Local state is a DRAFT. The in-force value is shown separately, so the
 * difference between "what I am looking at" and "what the system will do" is
 * always visible, and Save is the only thing that closes it.
 *
 * The controls disable themselves when the system is not SAFE OFF, but that is
 * courtesy only: the backend re-checks the same durable facts inside a
 * transaction under the profile advisory lock.
 */
export function RrLookbackEditor({
  status,
  onSaved,
}: {
  status: TradingControlStatusDto | null;
  onSaved: () => void;
}) {
  const policy = status?.rrLookback ?? null;
  const inForce = policy?.effective ?? null;
  const supported = policy?.supported ?? [];

  const [selection, setSelection] = useState<number | null>(inForce);
  const [touched, setTouched] = useState(false);
  const [save, setSave] = useState<RrLookbackSaveDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Adopt the server's value until the operator starts editing. After that the
  // draft is theirs: a background status refresh must never silently move a
  // radio they deliberately changed.
  useEffect(() => {
    if (!touched) setSelection(inForce);
  }, [inForce, touched]);

  const editable = canEditRrLookback(status);
  const savable = canSaveRrLookback({ selection, inForce, supported, editable: editable.allowed });
  const dirty = selection !== inForce;
  const authenticated = hasOperatorToken();

  const submit = async () => {
    if (busy || !savable.allowed || selection === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await postRrLookback(selection);
      setSave(result);
      if (result.ok) {
        // The server is the authority on what is now in force; re-read rather
        // than assuming the draft became the policy.
        setTouched(false);
        onSaved();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!authenticated) return null;

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-100">Extreme RR lookback</h2>
        <p className="text-xs text-slate-400">
          How many closed candles a NEW plan searches for its extreme. Existing plans and
          executions keep the window they were built under. Editable only while SAFE OFF.
        </p>
      </div>

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs text-slate-400">
        <dt>In force</dt>
        <dd className={policy && policy.valid ? "text-slate-200" : "text-red-300"}>
          {policy ? describeRrLookback(policy) : "—"}
        </dd>
      </dl>

      {policy && !policy.valid ? (
        <p className="text-xs text-red-300">
          The stored lookback is not one of the supported windows, so new Extreme RR planning
          refuses rather than guessing. Save a supported value to clear this.
        </p>
      ) : null}

      {!open ? (
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Edit lookback
        </Button>
      ) : (
        <>
          <fieldset className="flex flex-wrap gap-3" disabled={busy}>
            <legend className="sr-only">Extreme RR lookback candles</legend>
            {supported.map((candles) => (
              <label key={candles} className="flex items-center gap-1.5 text-xs text-slate-200">
                <input
                  type="radio"
                  name="rr-lookback"
                  value={candles}
                  checked={selection === candles}
                  onChange={() => {
                    setTouched(true);
                    setSave(null);
                    setSelection(candles);
                  }}
                  className="h-3.5 w-3.5 border-surface-border bg-surface"
                />
                <span className="font-mono">{candles}</span>
                <span className="text-slate-400">candles</span>
              </label>
            ))}
          </fieldset>

          {dirty ? (
            <p className="text-xs text-yellow-300">
              Unsaved draft — the system still plans with:{" "}
              {policy ? describeRrLookback(policy) : "—"}
            </p>
          ) : null}

          {!editable.allowed && editable.reason ? (
            <p className="text-xs text-yellow-300">{editable.reason}</p>
          ) : null}
          {savable.reason ? <p className="text-xs text-slate-400">{savable.reason}</p> : null}

          <div className="flex gap-2">
            <Button type="button" onClick={() => void submit()} disabled={busy || !savable.allowed}>
              {busy ? "Saving…" : "Save lookback"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy || !dirty}
              onClick={() => {
                setTouched(false);
                setSelection(inForce);
                setSave(null);
              }}
            >
              Discard draft
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Close
            </Button>
          </div>

          {error ? <p className="text-xs text-red-300">{error}</p> : null}

          {save ? (
            <p className={save.ok ? "text-xs text-emerald-300" : "text-xs text-red-300"}>
              {save.message}
              {save.blockers.length > 0 ? ` (${save.blockers.join(", ")})` : ""}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
