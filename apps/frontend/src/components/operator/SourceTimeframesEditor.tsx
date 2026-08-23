import { useEffect, useState } from "react";

import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import {
  postSourceTimeframes,
  type SourceTimeframeSaveDto,
  type TradingControlStatusDto,
} from "../../api/operator";
import { hasOperatorToken } from "../../api/operator-token";
import {
  canEditSourceTimeframes,
  canSaveSourceTimeframes,
  describeSourceTimeframes,
  sameSelection,
  toggleSourceTimeframe,
} from "../../features/operator/tradingControlActions";

/**
 * The operator's Source Timeframe editor.
 *
 * The filter is on the timeframe the LEVEL originated on — the `sourceTf` the
 * Pine note carries — never the chart timeframe the retest alert fired on. A
 * 15m alert against a 1W level is a 1W signal here.
 *
 * Local checkbox state is a DRAFT and nothing more. The panel shows what is
 * in force separately from what is selected, so an operator can always see the
 * difference between "what I am looking at" and "what the system will do", and
 * Save is the only thing that closes that gap.
 *
 * The controls disable themselves when the system is not SAFE OFF, but that is
 * courtesy only: the backend re-checks the same durable facts inside a
 * transaction under the profile advisory lock, so a browser that ignores this
 * still cannot write.
 */
export function SourceTimeframesEditor({
  status,
  onSaved,
}: {
  status: TradingControlStatusDto | null;
  onSaved: () => void;
}) {
  const policy = status?.sourceTimeframes ?? null;
  const inForce = policy?.enforceable ?? [];
  const supported = policy?.supported ?? [];

  const [selection, setSelection] = useState<string[]>(inForce);
  const [touched, setTouched] = useState(false);
  const [save, setSave] = useState<SourceTimeframeSaveDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Adopt the server's value until the operator starts editing. After that the
  // draft is theirs: a background status refresh must never silently discard
  // half-made changes, and must never quietly re-tick a box they unticked.
  useEffect(() => {
    if (!touched) setSelection(inForce);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inForce.join(","), touched]);

  const editable = canEditSourceTimeframes(status);
  const savable = canSaveSourceTimeframes({ selection, inForce, editable: editable.allowed });
  const dirty = !sameSelection(selection, inForce);
  const authenticated = hasOperatorToken();

  const submit = async () => {
    if (busy || !savable.allowed) return;
    setBusy(true);
    setError(null);
    try {
      const result = await postSourceTimeframes(selection);
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
        <h2 className="text-sm font-semibold text-slate-100">Source timeframes</h2>
        <p className="text-xs text-slate-400">
          Which timeframe a LEVEL must come from to be eligible for execution — not the chart
          timeframe the alert fired on. Editable only while SAFE OFF.
        </p>
      </div>

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs text-slate-400">
        <dt>In force</dt>
        <dd className={policy && policy.valid ? "text-slate-200" : "text-red-300"}>
          {policy ? describeSourceTimeframes(policy) : "—"}
        </dd>
      </dl>

      {policy && policy.unrecognized.length > 0 ? (
        <p className="text-xs text-red-300">
          The stored policy carries {policy.unrecognized.length} unrecognised value(s). They admit
          nothing and are ignored — save a fresh selection to clear them.
        </p>
      ) : null}

      {!open ? (
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Edit source timeframes
        </Button>
      ) : (
        <>
          <fieldset className="space-y-1.5" disabled={busy}>
            <legend className="sr-only">Allowed source timeframes</legend>
            {supported.map((timeframe) => {
              const checked = selection.includes(timeframe);
              const inForceHere = inForce.includes(timeframe);
              return (
                <label key={timeframe} className="flex items-center gap-2 text-xs text-slate-200">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      setTouched(true);
                      setSave(null);
                      setSelection((current) => toggleSourceTimeframe(current, timeframe, supported));
                    }}
                    className="h-3.5 w-3.5 rounded border-surface-border bg-surface"
                  />
                  <span className="font-mono">{timeframe}</span>
                  {checked !== inForceHere ? (
                    <span className="text-[10px] uppercase tracking-wide text-yellow-300">
                      {checked ? "will be added" : "will be removed"}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </fieldset>

          {dirty ? (
            <p className="text-xs text-yellow-300">
              Unsaved draft — the system still enforces: {policy ? describeSourceTimeframes(policy) : "—"}
            </p>
          ) : null}

          {!editable.allowed && editable.reason ? (
            <p className="text-xs text-yellow-300">{editable.reason}</p>
          ) : null}
          {savable.reason ? <p className="text-xs text-slate-400">{savable.reason}</p> : null}

          <div className="flex gap-2">
            <Button type="button" onClick={() => void submit()} disabled={busy || !savable.allowed}>
              {busy ? "Saving…" : "Save source timeframes"}
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
