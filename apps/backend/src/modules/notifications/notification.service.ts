import path from "node:path";
import type { Alert } from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { ensureScreenshotDir, screenshotFileName } from "../../utils/file";
import { emitAlertDuplicate, emitAlertFailed, emitAlertUpdated, emitNewAlert } from "./socket-events";
import { sendTelegramMessage, sendTelegramPhoto } from "./telegram.service";

/**
 * Realtime dashboard events only. Telegram is intentionally NOT sent here:
 * the webhook request path must stay fast, and a freshly-received alert has
 * no analysis yet. The Telegram notification is sent later by the worker once
 * the alert reaches ANALYZED (see notifyAnalyzedAlert).
 */
export async function notifyNewAlert(alert: Alert): Promise<void> {
  emitNewAlert(alert);
}

/**
 * Realtime dashboard event for every status transition. No Telegram here —
 * that is handled once, explicitly, via notifyAnalyzedAlert.
 */
export async function notifyAlertUpdated(alert: Alert): Promise<void> {
  emitAlertUpdated(alert);
}

/**
 * No Telegram message here on purpose — duplicate suppression exists to cut
 * down on alert spam, so re-notifying on every duplicate would defeat the
 * point. The dashboard still reflects it live via the socket event.
 */
export async function notifyAlertDuplicate(alert: Alert): Promise<void> {
  emitAlertDuplicate(alert);
}

/**
 * Emits the failure socket event and, only when TELEGRAM_NOTIFY_ON_FAILED is
 * set, a short Telegram message. Telegram sending is best-effort and never
 * throws, so this is safe to call from the worker's catch block.
 */
export async function notifyAlertFailed(alert: Alert): Promise<void> {
  emitAlertFailed(alert);

  if (!env.TELEGRAM_NOTIFY_ON_FAILED) return;

  const text = [
    `⚠️ Alert FAILED — ${alert.symbol} (${alert.timeframe})`,
    `Signal: ${alert.signal}`,
    `Error: ${alert.errorMessage ?? "unknown error"}`,
  ].join("\n");

  await sendTelegramMessage(text);
}

function dashboardAlertUrl(alert: Alert): string {
  return `${env.FRONTEND_URL.replace(/\/$/, "")}/alerts/${alert.id}`;
}

function formatConfidence(confidence: number | null): string {
  if (confidence === null) return "n/a";
  return `${Math.round(confidence * 100)}%`;
}

function buildAnalyzedMessage(alert: Alert): string {
  const riskNotes = Array.isArray(alert.aiRiskNotes) ? (alert.aiRiskNotes as string[]) : [];

  const lines = [
    `✅ Alert ANALYZED — ${alert.symbol}${alert.exchange ? ` (${alert.exchange})` : ""}`,
    `Signal: ${alert.signal} @ ${alert.price}`,
    `Timeframe: ${alert.timeframe} · Type: ${alert.assetType}`,
    "",
    `AI (${alert.aiProvider ?? "n/a"}): ${alert.aiBias ?? "n/a"} · confidence ${formatConfidence(alert.aiConfidence)}`,
  ];

  if (alert.aiSummary) lines.push(`Summary: ${alert.aiSummary}`);

  if (riskNotes.length > 0) {
    lines.push("Risks:");
    for (const note of riskNotes) lines.push(`• ${note}`);
  }

  lines.push("", `Dashboard: ${dashboardAlertUrl(alert)}`);
  return lines.join("\n");
}

/**
 * Sends the Telegram notification for a fully-analyzed alert. Called by the
 * worker after the alert is marked ANALYZED and the socket event is emitted.
 *
 * Guards:
 * - Only ANALYZED alerts notify (duplicates never reach here — they're
 *   suppressed before the worker ever runs — but we check defensively).
 * - Honors TELEGRAM_MIN_CONFIDENCE: below-threshold analyses are skipped.
 *
 * When TELEGRAM_SEND_SCREENSHOT is on and a screenshot exists, sends it as a
 * photo with the analysis as caption, falling back to a text-only message if
 * the photo send fails. All sends are best-effort and never throw.
 */
export async function notifyAnalyzedAlert(alert: Alert): Promise<void> {
  if (alert.status !== "ANALYZED") return;

  const minConfidence = env.TELEGRAM_MIN_CONFIDENCE;
  if (minConfidence > 0 && (alert.aiConfidence ?? 0) < minConfidence) {
    logger.info(
      { alertId: alert.id, aiConfidence: alert.aiConfidence, minConfidence },
      "Skipping Telegram notification: confidence below TELEGRAM_MIN_CONFIDENCE"
    );
    return;
  }

  const text = buildAnalyzedMessage(alert);

  if (env.TELEGRAM_SEND_SCREENSHOT && alert.screenshotUrl) {
    const dir = await ensureScreenshotDir();
    const imagePath = path.join(dir, screenshotFileName(alert.id));

    const photoSent = await sendTelegramPhoto(imagePath, text);
    if (photoSent) return;

    // Photo failed (missing file, Telegram error, …) — fall back to text.
  }

  await sendTelegramMessage(text);
}
