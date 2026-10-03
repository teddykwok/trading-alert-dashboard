import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { MockAiBadge } from "./MockAiBadge";
import { OpenAiBadge } from "./OpenAiBadge";
import { formatPercent } from "../../utils/formatPrice";
import { isNativeAlert } from "../../utils/alertSource";
import type { Alert } from "../../types/alert";

export const NATIVE_AI_NOT_APPLICABLE =
  "Not applicable: Native scanner alerts are not sent to the TradingView screenshot and AI vision pipeline.";

interface AiOpinionPanelProps {
  alert: Alert;
}

export function AiOpinionPanel({ alert }: AiOpinionPanelProps) {
  if (isNativeAlert(alert)) {
    return (
      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-200">AI Vision Opinion</h3>
        <p className="text-sm text-slate-500">{NATIVE_AI_NOT_APPLICABLE}</p>
      </Card>
    );
  }

  if (alert.status === "FAILED") {
    return (
      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-200">AI Vision Opinion</h3>
        <p className="text-sm text-red-400">{alert.errorMessage ?? "Analysis failed."}</p>
      </Card>
    );
  }

  if (!alert.aiSummary) {
    return (
      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-200">AI Vision Opinion</h3>
        <p className="text-sm text-slate-500">Waiting for analysis…</p>
      </Card>
    );
  }

  const riskNotes = alert.aiRiskNotes ?? [];
  const isMock = alert.aiProvider === "mock";
  const isOpenAi = alert.aiProvider === "openai";

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">AI Vision Opinion</h3>
        <div className="flex items-center gap-2">
          {isMock && <MockAiBadge />}
          {isOpenAi && <OpenAiBadge />}
          {alert.aiBias && <Badge tone="blue">{alert.aiBias.replace(/_/g, " ")}</Badge>}
        </div>
      </div>

      {isMock && (
        <p className="mb-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400">
          This is mock AI analysis for pipeline testing only. Do not use it for trading decisions.
        </p>
      )}

      {isOpenAi && (
        <p className="mb-3 text-xs text-slate-500">
          AI vision analysis is informational and based only on the chart screenshot.
        </p>
      )}

      {alert.aiConfidence !== null && (
        <div className="mb-3">
          <div className="mb-1 flex justify-between text-xs text-slate-500">
            <span>Confidence</span>
            <span>{formatPercent(alert.aiConfidence)}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-surface-border">
            <div
              className="h-1.5 rounded-full bg-blue-500"
              style={{ width: `${Math.round(alert.aiConfidence * 100)}%` }}
            />
          </div>
        </div>
      )}

      {alert.aiPattern && <p className="mb-2 text-sm text-slate-300">{alert.aiPattern}</p>}
      <p className="mb-3 text-sm text-slate-400">{alert.aiSummary}</p>

      {riskNotes.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Risk notes</p>
          <ul className="list-disc space-y-1 pl-4 text-xs text-slate-400">
            {riskNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-4 text-[11px] italic text-slate-600">
        AI-generated visual analysis only — not financial advice.
      </p>
    </Card>
  );
}
