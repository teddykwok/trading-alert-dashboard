import { useEffect, useState } from "react";
import { Card } from "../components/ui/Card";
import { settingsApi } from "../api/settings.api";
import type { WebhookInfoResponse } from "../types/api";

export function SettingsPage() {
  const [info, setInfo] = useState<WebhookInfoResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    settingsApi
      .getWebhookInfo()
      .then(setInfo)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!info) return <p className="text-sm text-red-400">Could not load settings.</p>;

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <h1 className="text-lg font-semibold text-slate-100">Settings</h1>

      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-200">TradingView webhook URL</h2>
        <p className="mb-2 text-xs text-slate-500">
          Paste this into the "Webhook URL" field of your TradingView alert.
        </p>
        <code className="block break-all rounded-lg bg-surface p-3 text-xs text-blue-400">
          {info.webhookUrl}
        </code>
      </Card>

      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-200">Webhook secret</h2>
        <p className="text-xs text-slate-400">{info.reminder}</p>
      </Card>

      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold text-slate-200">Sample alert message JSON</h2>
        <p className="mb-2 text-xs text-slate-500">
          Use this as the alert message body in TradingView (adjust values with placeholders like{" "}
          <code>{"{{close}}"}</code> as needed).
        </p>
        <pre className="overflow-auto rounded-lg bg-surface p-3 text-xs text-slate-400">
          {JSON.stringify(info.samplePayload, null, 2)}
        </pre>
      </Card>
    </div>
  );
}
