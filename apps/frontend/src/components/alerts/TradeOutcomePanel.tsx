import { useEffect, useState } from "react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { OutcomeBadge } from "./OutcomeBadge";
import { tradeReviewsApi, type TradeReviewUpsertInput } from "../../api/trade-reviews.api";
import { formatDateTime } from "../../utils/formatDate";
import { formatPrice } from "../../utils/formatPrice";
import type { TradeReview, TradeReviewStatus } from "@trading-alert-dashboard/shared";

const STATUS_ACTIONS: Array<{ status: TradeReviewStatus; label: string }> = [
  { status: "IGNORED", label: "Ignored" },
  { status: "OPEN", label: "Open" },
  { status: "WIN", label: "Win" },
  { status: "LOSS", label: "Loss" },
  { status: "BREAKEVEN", label: "Breakeven" },
];

const PRICE_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Prices are kept as raw strings end-to-end (inputs -> API -> Prisma Decimal)
 * so small-cap precision like 0.004086 is never destroyed by float
 * round-tripping. Number() is used only for read-only display formatting.
 */
function displayPrice(value: string | null): string {
  return value === null ? "—" : formatPrice(Number(value));
}

export function TradeOutcomePanel({ alertId }: { alertId: string }) {
  const [review, setReview] = useState<TradeReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const [entryPrice, setEntryPrice] = useState("");
  const [exitPrice, setExitPrice] = useState("");
  const [notes, setNotes] = useState("");

  function syncFields(next: TradeReview) {
    setReview(next);
    setEntryPrice(next.entryPrice ?? "");
    setExitPrice(next.exitPrice ?? "");
    setNotes(next.notes ?? "");
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    tradeReviewsApi
      .getForAlert(alertId)
      .then(syncFields)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load trade review"))
      .finally(() => setLoading(false));
  }, [alertId]);

  async function save(input: TradeReviewUpsertInput) {
    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      const updated = await tradeReviewsApi.upsertForAlert(alertId, input);
      syncFields(updated);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save trade review");
    } finally {
      setSaving(false);
    }
  }

  function markStatus(status: TradeReviewStatus) {
    if (saving) return;
    if (status === "UNREVIEWED" && !window.confirm("Reset this review to Unreviewed?")) return;
    void save({ status });
  }

  function saveDetails() {
    if (saving) return;

    const entry = entryPrice.trim();
    const exit = exitPrice.trim();
    if (entry && !PRICE_PATTERN.test(entry)) {
      setError('Entry price must be a plain decimal, e.g. "0.004086"');
      return;
    }
    if (exit && !PRICE_PATTERN.test(exit)) {
      setError('Exit price must be a plain decimal, e.g. "0.004086"');
      return;
    }

    void save({
      entryPrice: entry === "" ? null : entry,
      exitPrice: exit === "" ? null : exit,
      notes: notes.trim() === "" ? null : notes,
    });
  }

  if (loading) {
    return (
      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-200">Trade Outcome</h2>
        <p className="text-sm text-slate-500">Loading…</p>
      </Card>
    );
  }

  const status = review?.status ?? "UNREVIEWED";
  const inputClass =
    "w-full rounded-lg border border-surface-border bg-surface px-2.5 py-1.5 text-sm text-slate-200 focus:border-blue-500 focus:outline-none";

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">Trade Outcome</h2>
        <OutcomeBadge status={status} />
      </div>

      <p className="mb-3 text-xs text-slate-500">
        Manual review — record what you actually did with this alert. Nothing is inferred
        automatically.
      </p>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {STATUS_ACTIONS.map((action) => (
          <Button
            key={action.status}
            variant={status === action.status ? "primary" : "secondary"}
            disabled={saving}
            onClick={() => markStatus(action.status)}
          >
            {action.label}
          </Button>
        ))}
        {status !== "UNREVIEWED" && (
          <Button variant="ghost" disabled={saving} onClick={() => markStatus("UNREVIEWED")}>
            Reset
          </Button>
        )}
      </div>

      <dl className="mb-3 space-y-1.5 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-slate-500">Entry price</dt>
          <dd className="text-slate-200">{displayPrice(review?.entryPrice ?? null)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-slate-500">Exit price</dt>
          <dd className="text-slate-200">{displayPrice(review?.exitPrice ?? null)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-slate-500">Opened</dt>
          <dd className="text-slate-200">{review?.openedAt ? formatDateTime(review.openedAt) : "—"}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-slate-500">Closed</dt>
          <dd className="text-slate-200">{review?.closedAt ? formatDateTime(review.closedAt) : "—"}</dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2">
        <input
          type="text"
          inputMode="decimal"
          placeholder="Entry price (e.g. 0.004086)"
          value={entryPrice}
          onChange={(e) => setEntryPrice(e.target.value)}
          className={inputClass}
        />
        <input
          type="text"
          inputMode="decimal"
          placeholder="Exit price"
          value={exitPrice}
          onChange={(e) => setExitPrice(e.target.value)}
          className={inputClass}
        />
        <textarea
          placeholder="Notes (what happened, why you took/skipped it)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className={inputClass}
        />
        <div className="flex items-center gap-2">
          <Button variant="secondary" disabled={saving} onClick={saveDetails}>
            {saving ? "Saving…" : "Save details"}
          </Button>
          {justSaved && <span className="text-xs text-green-400">Saved ✓</span>}
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </Card>
  );
}
