import type { Alert } from "@prisma/client";
import { emitAlertDuplicate, emitAlertFailed, emitAlertUpdated, emitNewAlert } from "./socket-events";
import { sendTelegramMessage } from "./telegram.service";

export async function notifyNewAlert(alert: Alert): Promise<void> {
  emitNewAlert(alert);
  await sendTelegramMessage(
    `🔔 *${alert.signal}* alert on *${alert.symbol}* (${alert.timeframe}) @ ${alert.price}`
  );
}

export async function notifyAlertUpdated(alert: Alert): Promise<void> {
  emitAlertUpdated(alert);

  if (alert.status === "ANALYZED") {
    await sendTelegramMessage(
      `✅ AI analysis ready for *${alert.symbol}*: ${alert.aiBias ?? "n/a"} (confidence ${alert.aiConfidence ?? "n/a"})`
    );
  }
}

export async function notifyAlertFailed(alert: Alert): Promise<void> {
  emitAlertFailed(alert);
  await sendTelegramMessage(
    `⚠️ Processing failed for *${alert.symbol}*: ${alert.errorMessage ?? "unknown error"}`
  );
}

/**
 * No Telegram message here on purpose — duplicate suppression exists to cut
 * down on alert spam, so re-notifying on every duplicate would defeat the
 * point. The dashboard still reflects it live via the socket event.
 */
export async function notifyAlertDuplicate(alert: Alert): Promise<void> {
  emitAlertDuplicate(alert);
}
