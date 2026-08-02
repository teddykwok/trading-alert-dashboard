import { useEffect, useState, type FormEvent } from "react";
import type { RiskTemplate } from "@trading-alert-dashboard/shared";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { EmptyState } from "../components/ui/EmptyState";
import { riskTemplatesApi, type RiskTemplateInput } from "../api/risk-templates.api";
import { ApiRequestError } from "../api/client";

/** Convenience prefill for the very first template (nothing is saved until Create). */
const FIRST_TEMPLATE_DEFAULTS: RiskTemplateInput = {
  name: "Current $400",
  referenceCapital: "400",
  riskPercent: "1",
  rewardRatio: "1.5",
};

const EMPTY_FORM: RiskTemplateInput = { name: "", referenceCapital: "", riskPercent: "", rewardRatio: "" };

const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;

/** "$400", "$6.0015" — decimal strings from the API are already trimmed of trailing zeros. */
function usd(value: string): string {
  return `$${value}`;
}

const inputClass =
  "w-full rounded-lg border border-surface-border bg-surface px-2.5 py-1.5 text-sm text-slate-200 focus:border-blue-500 focus:outline-none";
const labelClass = "mb-1 block text-xs text-slate-500";

/**
 * Dedicated page for risk templates: the ACTIVE template summary (step-based
 * fixed reference capital, never an exchange balance) plus list / create /
 * edit / activate / delete. riskAmount and targetAmount are always the values
 * the API derived from the stored template — never recomputed here.
 */
export function RiskTemplatesPage() {
  const [templates, setTemplates] = useState<RiskTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<RiskTemplateInput>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const active = templates.find((template) => template.isActive) ?? null;

  async function refetch() {
    try {
      setTemplates(await riskTemplatesApi.list());
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load risk templates");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refetch();
  }, []);

  function openCreate() {
    setEditingId(null);
    setForm(templates.length === 0 ? FIRST_TEMPLATE_DEFAULTS : EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(template: RiskTemplate) {
    setEditingId(template.id);
    setForm({
      name: template.name,
      referenceCapital: template.referenceCapital,
      riskPercent: template.riskPercent,
      rewardRatio: template.rewardRatio,
    });
    setFormError(null);
    setModalOpen(true);
  }

  function validateForm(): string | null {
    if (!form.name.trim()) return "Name must not be empty.";
    for (const [label, value] of [
      ["Reference capital", form.referenceCapital],
      ["Risk %", form.riskPercent],
      ["Reward ratio", form.rewardRatio],
    ] as const) {
      const trimmed = value.trim();
      if (!DECIMAL_PATTERN.test(trimmed) || !/[1-9]/.test(trimmed)) {
        return `${label} must be a decimal greater than zero, e.g. "400" or "1.5".`;
      }
    }
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      return;
    }

    const input: RiskTemplateInput = {
      name: form.name.trim(),
      referenceCapital: form.referenceCapital.trim(),
      riskPercent: form.riskPercent.trim(),
      rewardRatio: form.rewardRatio.trim(),
    };

    setSaving(true);
    setFormError(null);
    try {
      if (editingId) {
        await riskTemplatesApi.update(editingId, input);
      } else {
        await riskTemplatesApi.create(input);
      }
    } catch (error) {
      setFormError(error instanceof ApiRequestError ? error.message : "Request failed — please try again.");
      setSaving(false);
      return;
    }
    setSaving(false);
    setModalOpen(false);
    await refetch();
  }

  async function handleActivate(template: RiskTemplate) {
    setActionError(null);
    try {
      await riskTemplatesApi.activate(template.id);
    } catch (error) {
      setActionError(
        error instanceof ApiRequestError
          ? `Could not activate ${template.name}: ${error.message}`
          : `Could not activate ${template.name} — please try again.`
      );
      return;
    }
    await refetch();
  }

  async function handleDelete(template: RiskTemplate) {
    if (!window.confirm(`Delete template "${template.name}"?`)) return;
    setActionError(null);
    try {
      await riskTemplatesApi.remove(template.id);
    } catch (error) {
      setActionError(
        error instanceof ApiRequestError
          ? `Could not delete ${template.name}: ${error.message}`
          : `Could not delete ${template.name} — please try again.`
      );
      return;
    }
    await refetch();
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-100">Risk Templates</h1>
        <Button onClick={openCreate}>Add template</Button>
      </div>

      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-200">Active risk template</h2>

        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : loadError ? (
          <p className="text-sm text-red-400">{loadError}</p>
        ) : active ? (
          <div>
            <p className="text-base font-semibold text-slate-100">{active.name}</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Capital {usd(active.referenceCapital)} · Risk {active.riskPercent}% · RR 1:{active.rewardRatio}
            </p>
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">Risk per trade</dt>
                <dd className="font-semibold text-slate-100">{usd(active.riskAmount)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">Target per trade</dt>
                <dd className="font-semibold text-slate-100">{usd(active.targetAmount)}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            No active risk template. Create one below — planning defaults stay fixed until you change
            them.
          </p>
        )}
      </Card>

      {actionError && <p className="text-sm text-red-400">{actionError}</p>}

      {!loading && !loadError && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-slate-200">All templates</h2>

          {templates.length === 0 ? (
            <EmptyState
              title="No risk templates yet"
              description="Create a template with your fixed reference capital, risk % and reward ratio."
            />
          ) : (
            templates.map((template) => (
              <Card key={template.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-100">{template.name}</span>
                    {template.isActive && <Badge tone="green">Active</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Capital {usd(template.referenceCapital)} · Risk {template.riskPercent}% · RR 1:
                    {template.rewardRatio} → risk {usd(template.riskAmount)}, target{" "}
                    {usd(template.targetAmount)}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  {!template.isActive && (
                    <Button variant="ghost" onClick={() => handleActivate(template)}>
                      Activate
                    </Button>
                  )}
                  <Button variant="secondary" onClick={() => openEdit(template)}>
                    Edit
                  </Button>
                  {/* The active template is the one in use — deletion is
                      blocked server-side, so no Delete button here. */}
                  {!template.isActive && (
                    <Button variant="danger" onClick={() => handleDelete(template)}>
                      Delete
                    </Button>
                  )}
                </div>
              </Card>
            ))
          )}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? "Edit template" : "New template"}
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div>
            <label className={labelClass}>Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder='e.g. "Current $400"'
              className={inputClass}
            />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <label className={labelClass}>Reference capital (USD)</label>
              <input
                inputMode="decimal"
                value={form.referenceCapital}
                onChange={(e) => setForm((f) => ({ ...f, referenceCapital: e.target.value }))}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Risk per trade (%)</label>
              <input
                inputMode="decimal"
                value={form.riskPercent}
                onChange={(e) => setForm((f) => ({ ...f, riskPercent: e.target.value }))}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Reward ratio (1:x)</label>
              <input
                inputMode="decimal"
                value={form.rewardRatio}
                onChange={(e) => setForm((f) => ({ ...f, rewardRatio: e.target.value }))}
                className={inputClass}
              />
            </div>
          </div>
          <p className="text-[11px] text-slate-500">
            Fixed reference capital: this number only changes when you edit it — it is never synced
            from your real balance.
          </p>
          {formError && <p className="text-sm text-red-400">{formError}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : editingId ? "Save changes" : "Create"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
