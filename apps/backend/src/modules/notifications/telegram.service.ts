import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env";
import { logger } from "../../config/logger";

const TELEGRAM_API_BASE = "https://api.telegram.org";
// Telegram hard-limits photo captions to 1024 characters.
const MAX_CAPTION_LENGTH = 1024;

/**
 * Whether we should attempt to send at all. Returns false (and never throws)
 * when notifications are disabled, or enabled but missing credentials — in
 * the latter case we log a clear, token-free warning so misconfiguration is
 * visible without leaking the secret.
 */
function canSend(): boolean {
  if (!env.TELEGRAM_NOTIFICATIONS_ENABLED) return false;

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    logger.warn(
      { hasToken: Boolean(env.TELEGRAM_BOT_TOKEN), hasChatId: Boolean(env.TELEGRAM_CHAT_ID) },
      "Telegram notifications are enabled but TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID is missing — skipping send"
    );
    return false;
  }

  return true;
}

// Never build a loggable string from the token; only used to build the URL.
function apiUrl(method: string): string {
  return `${TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
}

/**
 * Sends a plain-text Telegram message. Returns true on success, false if it
 * was skipped or failed. Deliberately swallows all errors — a Telegram
 * outage must never break the trading alert pipeline.
 *
 * No parse_mode is used: alert text can contain AI-generated free text with
 * characters that would break Telegram's Markdown parser and cause the send
 * to fail. Plain text guarantees delivery.
 */
export async function sendTelegramMessage(text: string): Promise<boolean> {
  if (!canSend()) return false;

  try {
    const response = await fetch(apiUrl("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.warn({ status: response.status, body: body.slice(0, 200) }, "Telegram sendMessage failed");
      return false;
    }

    return true;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Telegram sendMessage threw"
    );
    return false;
  }
}

/**
 * Sends a photo (the chart screenshot) with a caption via multipart form data.
 * Returns true on success, false if skipped or failed. Callers that need a
 * guaranteed delivery should fall back to sendTelegramMessage on false (see
 * notification.service.ts). Never throws.
 */
export async function sendTelegramPhoto(imagePath: string, caption: string): Promise<boolean> {
  if (!canSend()) return false;

  let buffer: Buffer;
  try {
    buffer = await readFile(imagePath);
  } catch (error) {
    logger.warn(
      { imagePath, error: error instanceof Error ? error.message : String(error) },
      "Telegram sendPhoto could not read screenshot"
    );
    return false;
  }

  try {
    const form = new FormData();
    form.append("chat_id", env.TELEGRAM_CHAT_ID);
    form.append("caption", caption.slice(0, MAX_CAPTION_LENGTH));
    // Copy into a fresh Uint8Array so the Blob is backed by a plain
    // ArrayBuffer (Node's Buffer type isn't a valid BlobPart under strict TS).
    const bytes = new Uint8Array(buffer.byteLength);
    bytes.set(buffer);
    const blob = new Blob([bytes], { type: "image/png" });
    form.append("photo", blob, path.basename(imagePath));

    const response = await fetch(apiUrl("sendPhoto"), { method: "POST", body: form });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.warn({ status: response.status, body: body.slice(0, 200) }, "Telegram sendPhoto failed");
      return false;
    }

    return true;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Telegram sendPhoto threw"
    );
    return false;
  }
}
