import { useEffect, useState } from "react";
import {
  summarizeChecklist,
  TRADE_CHECKLIST_ITEMS,
  TRADE_CONFIDENCE_MAX,
  TRADE_CONFIDENCE_MIN,
  TRADE_EMOTIONS,
  TRADE_EMOTION_LABELS,
  TRADE_JOURNAL_TEXT_LIMITS,
  type TradeChecklist,
  type TradeEmotion,
  type TradeJournalWithSummary,
} from "@trading-alert-dashboard/shared";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { tradeJournalsApi } from "../../api/trade-journals.api";

const EMPTY_CHECKLIST = Object.fromEntries(
  TRADE_CHECKLIST_ITEMS.map((item) => [item.key, false])
) as TradeChecklist;

const CONFIDENCE_OPTIONS = Array.from(
  { length: TRADE_CONFIDENCE_MAX - TRADE_CONFIDENCE_MIN + 1 },
  (_, i) => TRADE_CONFIDENCE_MIN + i
);

const inputClass =
  "w-full rounded-lg border border-surface-border bg-surface px-2.5 py-1.5 text-sm text-slate-200 focus:border-blue-500 focus:outline-none";

/**
 * Manual pre-trade checklist + psychology journal. Purely documentation:
 * saving is never blocked by incompleteness, nothing here changes the Trade
 * Outcome status or the risk plan, and no judgement is attached to the
 * numbers — "4 / 7" is just a count.
 */
export function TradeJournalPanel({ alertId }: { alertId: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const [checklist, setChecklist] = useState<TradeChecklist>(EMPTY_CHECKLIST);
  const [emotion, setEmotion] = useState<TradeEmotion | "">("");
  const [confidence, setConfidence] = useState<number | "">("");
  const [reasonForEntry, setReasonForEntry] = useState("");
  const [preTradeNotes, setPreTradeNotes] = useState("");
  const [postTradeReflection, setPostTradeReflection] = useState("");
  const [lessonLearned, setLessonLearned] = useState("");

  function syncFields(next: TradeJournalWithSummary) {
    setChecklist(
      Object.fromEntries(
        TRADE_CHECKLIST_ITEMS.map((item) => [item.key, next[item.key] === true])
      ) as TradeChecklist
    );
    setEmotion(next.emotion ?? "");
    setConfidence(next.confidenceLevel ?? "");
    setReasonForEntry(next.reasonForEntry ?? "");
    setPreTradeNotes(next.preTradeNotes ?? "");
    setPostTradeReflection(next.postTradeReflection ?? "");
    setLessonLearned(next.lessonLearned ?? "");
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    tradeJournalsApi
      .getForAlert(alertId)
      .then(syncFields)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load trade journal"))
      .finally(() => setLoading(false));
  }, [alertId]);

  async function saveJournal() {
    if (saving) return;
    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      const updated = await tradeJournalsApi.upsertForAlert(alertId, {
        ...checklist,
        emotion: emotion === "" ? null : emotion,
        confidenceLevel: confidence === "" ? null : confidence,
        reasonForEntry: reasonForEntry.trim() === "" ? null : reasonForEntry,
        preTradeNotes: preTradeNotes.trim() === "" ? null : preTradeNotes,
        postTradeReflection: postTradeReflection.trim() === "" ? null : postTradeReflection,
        lessonLearned: lessonLearned.trim() === "" ? null : lessonLearned,
      });
      // On failure the form state is left as typed; only a successful save
      // re-syncs from the server response.
      syncFields(updated);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save trade journal");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-200">Trade Checklist &amp; Journal</h2>
        <p className="text-sm text-slate-500">Loading…</p>
      </Card>
    );
  }

  // Live summary from the current (possibly unsaved) checkbox state.
  const summary = summarizeChecklist(checklist);
  const incompleteLabels = TRADE_CHECKLIST_ITEMS.filter((item) =>
    summary.incompleteItems.includes(item.key)
  ).map((item) => item.label);

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">Trade Checklist &amp; Journal</h2>
        <span className="text-xs font-semibold text-slate-300">
          {summary.isComplete
            ? `Ready: ${summary.completedCount} / ${summary.totalCount}`
            : `Incomplete: ${summary.completedCount} / ${summary.totalCount}`}
        </span>
      </div>

      <p className="mb-3 text-xs text-slate-500">
        Self-documentation only — nothing here blocks a trade or judges it.
      </p>

      <fieldset className="mb-3 flex flex-col gap-1.5" disabled={saving}>
        <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Pre-trade checklist
        </legend>
        {TRADE_CHECKLIST_ITEMS.map((item) => (
          <label key={item.key} className="flex cursor-pointer items-start gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={checklist[item.key]}
              onChange={(e) => setChecklist((prev) => ({ ...prev, [item.key]: e.target.checked }))}
              className="mt-0.5 h-4 w-4 accent-blue-500"
            />
            <span>{item.label}</span>
          </label>
        ))}
      </fieldset>

      {!summary.isComplete && (
        <p className="mb-3 text-xs text-slate-500">
          Remaining: {incompleteLabels.join(" · ")}
        </p>
      )}

      <div className="mb-3 grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Emotion before entering
          <select
            value={emotion}
            onChange={(e) => setEmotion(e.target.value as TradeEmotion | "")}
            className={inputClass}
            disabled={saving}
          >
            <option value="">—</option>
            {TRADE_EMOTIONS.map((value) => (
              <option key={value} value={value}>
                {TRADE_EMOTION_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Confidence (self-reported, 1–5)
          <select
            value={confidence}
            onChange={(e) => setConfidence(e.target.value === "" ? "" : Number(e.target.value))}
            className={inputClass}
            disabled={saving}
          >
            <option value="">—</option>
            {CONFIDENCE_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Reason for entry
          <textarea
            value={reasonForEntry}
            onChange={(e) => setReasonForEntry(e.target.value)}
            maxLength={TRADE_JOURNAL_TEXT_LIMITS.reasonForEntry}
            rows={2}
            className={inputClass}
            disabled={saving}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Pre-trade notes
          <textarea
            value={preTradeNotes}
            onChange={(e) => setPreTradeNotes(e.target.value)}
            maxLength={TRADE_JOURNAL_TEXT_LIMITS.preTradeNotes}
            rows={2}
            className={inputClass}
            disabled={saving}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Post-trade reflection
          <textarea
            value={postTradeReflection}
            onChange={(e) => setPostTradeReflection(e.target.value)}
            maxLength={TRADE_JOURNAL_TEXT_LIMITS.postTradeReflection}
            rows={2}
            className={inputClass}
            disabled={saving}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Lesson learned
          <textarea
            value={lessonLearned}
            onChange={(e) => setLessonLearned(e.target.value)}
            maxLength={TRADE_JOURNAL_TEXT_LIMITS.lessonLearned}
            rows={2}
            className={inputClass}
            disabled={saving}
          />
        </label>

        <div className="flex items-center gap-2">
          <Button variant="secondary" disabled={saving} onClick={() => void saveJournal()}>
            {saving ? "Saving…" : "Save journal"}
          </Button>
          {justSaved && <span className="text-xs text-green-400">Saved ✓</span>}
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </Card>
  );
}
