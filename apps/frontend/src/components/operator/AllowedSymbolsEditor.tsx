import { useState } from "react";

import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import {
  postSaveAllowlist,
  postValidateAllowlist,
  type AllowlistSaveDto,
  type AllowlistValidationDto,
  type TradingControlStatusDto,
} from "../../api/operator";
import { hasOperatorToken } from "../../api/operator-token";
import {
  canEditAllowlist,
  describeAllowlist,
  describeAllowlistCounts,
  groupRejections,
} from "../../features/operator/tradingControlActions";

/**
 * The operator's Allowed Symbols editor.
 *
 * Two deliberate steps: Validate answers "what would be saved?" and writes
 * nothing, Save performs the durable mutation. The browser sends the RAW text
 * both times — there is no "already validated" flag for it to assert, because
 * the server re-parses and re-validates on save and is the only authority on
 * what a symbol means.
 *
 * The controls disable themselves when the system is not SAFE OFF, but that is
 * courtesy only: the backend independently refuses the same states inside a
 * transaction, so a browser that ignores this still cannot write.
 */
export function AllowedSymbolsEditor({
  status,
  onSaved,
}: {
  status: TradingControlStatusDto | null;
  onSaved: () => void;
}) {
  const [text, setText] = useState("");
  const [validation, setValidation] = useState<AllowlistValidationDto | null>(null);
  const [save, setSave] = useState<AllowlistSaveDto | null>(null);
  const [busy, setBusy] = useState<"validate" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const editable = canEditAllowlist(status);
  const current = status?.allowedSymbols ?? [];
  const authenticated = hasOperatorToken();

  const run = async (mode: "validate" | "save") => {
    if (busy !== null) return;
    setBusy(mode);
    setError(null);
    try {
      if (mode === "validate") {
        setSave(null);
        setValidation(await postValidateAllowlist(text));
      } else {
        const result = await postSaveAllowlist(text);
        setSave(result);
        if (result.ok) {
          setValidation(null);
          onSaved();
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The request failed.");
    } finally {
      setBusy(null);
    }
  };

  if (!authenticated) return null;

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-100">Allowed symbols</h2>
        <p className="text-xs text-slate-400">
          The durable allowlist admission enforces. Editable only while SAFE OFF.
        </p>
      </div>
      <div className="space-y-3">
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs text-slate-400">
          <dt>In force</dt>
          <dd className={current.length === 0 ? "text-red-300" : "text-slate-200"}>
            {current.length === 0 ? describeAllowlist(current) : `${current.length}: ${describeAllowlist(current)}`}
          </dd>
        </dl>

        {!open ? (
          <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
            Edit allowlist
          </Button>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-xs text-slate-400">
                Paste TradingView symbols — commas, new lines or both. `.P` and `EXCHANGE:` prefixes
                are normalized.
              </span>
              <textarea
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  // A validation describes the text it was run on. Once the
                  // text moves, Save must go back to needing a fresh one —
                  // otherwise the button offers to save something nobody
                  // checked. The server would refuse it anyway; this stops the
                  // control from claiming otherwise.
                  setValidation(null);
                  setSave(null);
                }}
                rows={8}
                spellCheck={false}
                placeholder={"FHEUSDT.P,COWUSDT.P\nBTCUSDT.P"}
                className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 font-mono text-xs text-slate-200"
              />
            </label>

            {!editable.allowed ? (
              <p className="text-xs text-yellow-300">{editable.reason}</p>
            ) : null}

            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => void run("validate")}
                disabled={busy !== null}
              >
                {busy === "validate" ? "Validating…" : "Validate symbols"}
              </Button>
              <Button
                type="button"
                onClick={() => void run("save")}
                disabled={busy !== null || !editable.allowed || !validation?.ok}
              >
                {busy === "save" ? "Saving…" : "Save validated allowlist"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={busy !== null}>
                Close
              </Button>
            </div>

            {error ? <p className="text-xs text-red-300">{error}</p> : null}

            {validation ? (
              <div className="space-y-1 rounded-lg border border-surface-border p-2">
                <pre className="font-mono text-xs text-slate-300">
                  {describeAllowlistCounts(validation.counts).join("\n")}
                </pre>
                {validation.ok ? (
                  <p className="text-xs text-emerald-300">
                    Would save {validation.accepted.length}: {describeAllowlist(validation.accepted)}
                  </p>
                ) : (
                  <p className="text-xs text-red-300">{validation.refusal}</p>
                )}
                {validation.rejected.length > 0 ? (
                  <ul className="text-xs text-slate-400">
                    {groupRejections(validation.rejected).map((group) => (
                      <li key={group.reasonCode}>
                        {group.reasonCode}: {group.count}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {save ? (
              <p className={save.ok ? "text-xs text-emerald-300" : "text-xs text-red-300"}>
                {save.message}
                {save.blockers.length > 0 ? ` (${save.blockers.join(", ")})` : ""}
              </p>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}
