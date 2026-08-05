import path from "node:path";
import type { Alert, PrismaClient } from "@prisma/client";
import type { ExtremeRRPlanDto } from "@trading-alert-dashboard/shared";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { ensureScreenshotDir, screenshotFileName } from "../../utils/file";
import {
  buildExtremeRRErrorMessage,
  buildExtremeRRInvalidMessage,
  buildExtremeRRReadyMessage,
} from "./extreme-rr-telegram";
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
  // PUBLIC_DASHBOARD_URL (not FRONTEND_URL) so links in Telegram messages
  // work from a phone when the dashboard is exposed via a tunnel.
  return `${env.PUBLIC_DASHBOARD_URL.replace(/\/$/, "")}/alerts/${alert.id}`;
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

  // Actionable alerts get exactly ONE Telegram message: the concise Extreme
  // RR trade plan sent by the plan worker once the plan is READY (or a
  // fallback for INVALID/final ERROR). The verbose AI-oriented message is
  // suppressed for them — AI details stay available in the dashboard's AI
  // Vision tab. Non-actionable signals (WATCH/EXIT) keep the legacy message.
  if (alert.signal === "LONG" || alert.signal === "SHORT") return;

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

function telegramConfigured(): boolean {
  return Boolean(env.TELEGRAM_NOTIFICATIONS_ENABLED && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

/**
 * Sends the ONE Telegram notification for an Extreme RR plan's final outcome
 * (READY trade plan, INVALID fallback, or ERROR fallback — never PENDING).
 *
 * Idempotency: BullMQ retries and concurrent attempts race on an atomic
 * claim — `updateMany` moves telegramStatus from null/FAILED to SENDING, and
 * only the winner (count === 1) proceeds. A successful send is recorded as
 * SENT (terminal: never claimable again); a failed send is recorded as FAILED
 * and stays claimable so a retry can safely resend.
 *
 * For a READY plan a Telegram failure THROWS so the BullMQ job retries —
 * regeneration short-circuits on READY plans, so the retry re-sends without
 * refetching market data and the plan itself always stays READY. INVALID and
 * ERROR fallbacks are best-effort (logged, recorded, never thrown).
 */
export async function notifyExtremeRRPlanOutcome(
  prisma: PrismaClient,
  plan: ExtremeRRPlanDto,
  symbol: string
): Promise<void> {
  if (plan.status === "PENDING") return;

  const claimed = await prisma.extremeRRPlan.updateMany({
    where: { id: plan.id, OR: [{ telegramStatus: null }, { telegramStatus: "FAILED" }] },
    data: { telegramStatus: "SENDING" },
  });
  if (claimed.count === 0) return; // already sent, being sent, or skipped

  if (!telegramConfigured()) {
    await prisma.extremeRRPlan.update({
      where: { id: plan.id },
      data: { telegramStatus: "SKIPPED", telegramLastError: null },
    });
    return;
  }

  const text =
    plan.status === "READY"
      ? buildExtremeRRReadyMessage(plan, symbol)
      : plan.status === "INVALID"
        ? buildExtremeRRInvalidMessage(plan, symbol)
        : buildExtremeRRErrorMessage(plan, symbol);

  if (!text) {
    // READY without a usable candidate should not happen; record and move on.
    await prisma.extremeRRPlan.update({
      where: { id: plan.id },
      data: { telegramStatus: "SKIPPED", telegramLastError: "No usable candidate for READY message" },
    });
    return;
  }

  const sent = await sendTelegramMessage(text);

  if (sent) {
    await prisma.extremeRRPlan.update({
      where: { id: plan.id },
      data: { telegramStatus: "SENT", telegramNotifiedAt: new Date(), telegramLastError: null },
    });
    logger.info({ alertId: plan.alertId, planStatus: plan.status }, "Extreme RR Telegram notification sent");
    return;
  }

  await prisma.extremeRRPlan.update({
    where: { id: plan.id },
    // Generic, token-free error text; telegram.service already logged details.
    data: { telegramStatus: "FAILED", telegramLastError: "Telegram send failed" },
  });

  if (plan.status === "READY") {
    throw new Error(`Telegram notification failed for READY Extreme RR plan (alert ${plan.alertId})`);
  }
  logger.warn(
    { alertId: plan.alertId, planStatus: plan.status },
    "Extreme RR fallback Telegram notification failed (best-effort, not retried)"
  );
}
