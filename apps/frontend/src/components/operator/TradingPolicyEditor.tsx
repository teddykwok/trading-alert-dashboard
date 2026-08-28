import { useEffect, useState } from "react";

import {
  EDITABLE_POLICY_FIELDS,
  fetchPolicy,
  postSavePolicy,
  postValidatePolicy,
  type EditablePolicyField,
  type PolicyChangeDto,
  type PolicyReadDto,
  type PolicySaveDto,
} from "../../api/operator";
import { Button } from "../ui/Button";

/**
 * Operator editing of the durable execution policy LIMITS.
 *
 * ## Limits only
 *
 * Open positions, pending entries, total active, reserved risk and reserved
 * margin are COUNTED from execution rows. They are facts, not settings, and
 * this component renders no control that could set one — there is no endpoint
 * behind such a control either. Everything here changes what admission will
 * allow NEXT.
 *
 * ## Review before apply
 *
 * Nothing saves on change, blur or Enter. The operator edits a draft, presses
 * Review, sees CURRENT → NEW for each limit that actually moves, and only then
 * presses Apply. Cancel discards the draft outright. A policy edit is one
 * deliberate operation, not seven silent ones.
 *
 * ## The env ceiling
 *
 * The engine takes `min(env, policy)` for every limit, so the environment can
 * only tighten. A stored value above its ceiling is legal and inert, and the
 * panel says so rather than showing a number that governs nothing.
 */

const FIELD_LABELS: Record<EditablePolicyField, string> = {
  softOpenPositionTarget: "Target open positions",
  maxOpenPositions: "Maximum open positions",
  maxPendingEntries: "Maximum pending entries",
  maxTotalActiveTrades: "Maximum total active",
  maxActivePerSymbolSide: "Maximum same symbol + side",
  maxTotalPlannedRiskUsd: "Maximum aggregate risk (USD)",
  maxTotalIsolatedMarginUsd: "Maximum total isolated margin (USD)",
};

/** The two decimal limits are money; the rest are counts. */
const DECIMAL_FIELDS: readonly EditablePolicyField[] = [
  "maxTotalPlannedRiskUsd",
  "maxTotalIsolatedMarginUsd",
];

type Draft = Record<EditablePolicyField, string>;

function draftFrom(read: PolicyReadDto): Draft {
  const draft = {} as Draft;
  for (const field of EDITABLE_POLICY_FIELDS) {
    draft[field] = read.fields?.[field]?.stored ?? "";
  }
  return draft;
}

/** Only the fields the operator actually altered, as the API's draft shape. */
function changedValues(draft: Draft, read: PolicyReadDto): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of EDITABLE_POLICY_FIELDS) {
    const stored = read.fields?.[field]?.stored ?? "";
    const next = draft[field].trim();
    if (next === "" || next === stored) continue;
    // Counts go as numbers, money as plain decimal strings — the shapes the
    // server's validator expects. It re-checks both regardless.
    values[field] = DECIMAL_FIELDS.includes(field) ? next : Number(next);
  }
  return values;
}

export function TradingPolicyEditor() {
  const [read, setRead] = useState<PolicyReadDto | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<PolicyChangeDto[] | null>(null);
  const [save, setSave] = useState<PolicySaveDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const next = await fetchPolicy();
      setRead(next);
      setDraft(draftFrom(next));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Policy could not be read.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const dirty =
    read !== null && draft !== null && Object.keys(changedValues(draft, read)).length > 0;

  function cancel() {
    // Discards the draft outright — the editor reopens from stored values.
    if (read) setDraft(draftFrom(read));
    setReview(null);
    setSave(null);
    setError(null);
    setOpen(false);
  }

  async function runReview() {
    if (!read || !draft) return;
    setBusy(true);
    setError(null);
    setSave(null);
    try {
      const result = await postValidatePolicy(changedValues(draft, read));
      if (!result.ok) {
        setReview(null);
        setError(result.refusal ?? "The proposed policy was refused.");
        return;
      }
      setReview(result.changes);
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "Review failed.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!read || !draft || read.version === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await postSavePolicy(changedValues(draft, read), read.version);
      setSave(result);
      setReview(null);
      // Always reload: on success to pick up the new version and values, on
      // refusal so the panel never keeps showing limits the server rejected.
      await load();
      if (result.ok) setOpen(false);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Apply failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!read) {
    return (
      <div className="text-xs text-slate-500" data-testid="policy-editor-loading">
        {error ?? "Loading policy limits…"}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="policy-editor">
      <dl className="grid gap-x-6 gap-y-1 md:grid-cols-2">
        {EDITABLE_POLICY_FIELDS.map((field) => {
          const view = read.fields?.[field];
          return (
            <div key={field} className="flex items-baseline justify-between gap-3">
              <dt className="text-xs text-slate-400">{FIELD_LABELS[field]}</dt>
              <dd className="text-xs text-slate-200">
                {view?.effective ?? "—"}
                {view?.cappedByEnv ? (
                  <span
                    className="ml-1 text-amber-400"
                    title={`Stored ${view.stored}, but the environment caps this at ${view.envCeiling}.`}
                  >
                    (env {view.envCeiling})
                  </span>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>

      {!open ? (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setOpen(true)}
            disabled={!read.editable}
          >
            Edit policy
          </Button>
          {!read.editable ? (
            <span className="text-xs text-slate-500" data-testid="policy-editor-blocked">
              {read.message}
            </span>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <div className="mt-1 flex flex-col gap-3 rounded border border-slate-800 p-3">
          {/* No auto-save: changing a field only edits the draft. */}
          <fieldset className="grid gap-2 md:grid-cols-2" disabled={busy}>
            {EDITABLE_POLICY_FIELDS.map((field) => (
              <label key={field} className="flex flex-col gap-1">
                <span className="text-[11px] text-slate-400">{FIELD_LABELS[field]}</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                  value={draft?.[field] ?? ""}
                  inputMode="decimal"
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, [field]: event.target.value } : current
                    )
                  }
                />
              </label>
            ))}
          </fieldset>

          {review ? (
            <div className="rounded border border-slate-700 p-2" data-testid="policy-review">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">
                Review changes
              </p>
              {review.length === 0 ? (
                <p className="mt-1 text-xs text-slate-400">No limit would change.</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-0.5">
                  {review.map((change) => (
                    <li key={change.field} className="text-xs text-slate-200">
                      {FIELD_LABELS[change.field]}{" "}
                      <span className="text-slate-500">{change.from}</span> →{" "}
                      <span className="text-emerald-400">{change.to}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {error ? (
            <p className="text-xs text-amber-400" data-testid="policy-editor-error">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => void runReview()} disabled={busy || !dirty}>
              Review changes
            </Button>
            <Button
              type="button"
              onClick={() => void apply()}
              // Apply is only reachable AFTER a review, so no draft can be
              // written without the operator having seen its before/after.
              disabled={busy || review === null || review.length === 0}
            >
              Apply policy
            </Button>
            <Button type="button" variant="secondary" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {save && !open ? (
        <p
          className={`text-xs ${save.ok ? "text-emerald-400" : "text-amber-400"}`}
          data-testid="policy-editor-result"
        >
          {save.message}
        </p>
      ) : null}
    </div>
  );
}
