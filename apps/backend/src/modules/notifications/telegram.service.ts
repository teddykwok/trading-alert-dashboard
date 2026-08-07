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

// ---------------------------------------------------------------------------
// Phase 9 — execution notification transport
// ---------------------------------------------------------------------------

/** Stable delivery-level codes. These are TRANSPORT outcomes and never replace
 *  a trading reason code — an execution's own decisionReasonCode is a different
 *  concept and is never overwritten by any value here. */
export const TELEGRAM_DELIVERY_CODES = [
  "TELEGRAM_EXECUTION_DISABLED",
  "TELEGRAM_DESTINATION_UNAVAILABLE",
  "TELEGRAM_FORMATTING_FAILED",
  "TELEGRAM_DELIVERY_RETRYABLE",
  "TELEGRAM_DELIVERY_PERMANENT_FAILURE",
  "TELEGRAM_DELIVERY_CLAIM_CONFLICT",
  "TELEGRAM_NOTIFICATION_PAYLOAD_INVALID",
] as const;

export type TelegramDeliveryCode = (typeof TELEGRAM_DELIVERY_CODES)[number];

export interface TelegramSendResult {
  delivered: boolean;
  /** False means "do not try this payload again" (e.g. bad chat id). */
  retryable: boolean;
  errorCode: TelegramDeliveryCode | null;
  /** One short line, no token, no chat id, no raw response body. */
  sanitizedError: string | null;
}

/**
 * The transport the notification dispatcher depends on. Injected, so tests use
 * a fake and never reach api.telegram.org.
 */
export type ExecutionTelegramSender = (chatId: string, text: string) => Promise<TelegramSendResult>;

/**
 * Where normal execution milestones go: the optional dedicated execution chat,
 * or the existing configured chat when it is empty. Returns null when nothing
 * is configured at all — the caller then leaves the notification retryable
 * rather than marking it delivered.
 */
export function resolveExecutionChatId(): string | null {
  const dedicated = env.TELEGRAM_EXECUTION_CHAT_ID.trim();
  if (dedicated !== "") return dedicated;
  const fallback = env.TELEGRAM_CHAT_ID.trim();
  return fallback === "" ? null : fallback;
}

/**
 * Where critical protection failures go: the EXISTING critical destination.
 * Deliberately not duplicated into the execution chat — one critical message
 * reaches one place, so nothing is acknowledged twice.
 */
/**
 * The Telegram master switch, as the notification runner sees it. False means
 * "do not attempt delivery at all" — the runner then skips claiming entirely so
 * no attempt budget is consumed while notifications are switched off.
 */
export function telegramDeliveryEnabled(): boolean {
  return env.TELEGRAM_NOTIFICATIONS_ENABLED && env.TELEGRAM_BOT_TOKEN !== "";
}

export function resolveCriticalChatId(): string | null {
  const configured = env.TELEGRAM_CHAT_ID.trim();
  return configured === "" ? null : configured;
}

/**
 * Telegram error codes that will never succeed on retry: the payload or the
 * destination is wrong, so re-sending burns attempts forever. Everything else
 * (network, 5xx, 429 rate limit) stays retryable.
 */
function classifyStatus(status: number): { retryable: boolean } {
  if (status === 429) return { retryable: true };
  if (status >= 500) return { retryable: true };
  // 400 Bad Request / 401 Unauthorized / 403 Forbidden / 404 chat not found.
  if (status >= 400) return { retryable: false };
  return { retryable: true };
}

/**
 * Sends one execution notification to an explicit chat. Never throws.
 *
 * Plain text, no parse_mode — the repository-wide Telegram convention (see the
 * comment on sendTelegramMessage). Nothing dynamic can break the parser, so no
 * escaping scheme has to be kept correct for arbitrary symbols and reason
 * codes.
 *
 * The returned error never contains the bot token, the chat id or the raw
 * response body.
 */
export async function sendExecutionTelegramMessage(
  chatId: string,
  text: string
): Promise<TelegramSendResult> {
  if (!env.TELEGRAM_NOTIFICATIONS_ENABLED) {
    return {
      delivered: false,
      retryable: true,
      errorCode: "TELEGRAM_EXECUTION_DISABLED",
      sanitizedError: "Telegram notifications are disabled.",
    };
  }
  if (!env.TELEGRAM_BOT_TOKEN || chatId.trim() === "") {
    return {
      delivered: false,
      retryable: true,
      errorCode: "TELEGRAM_DESTINATION_UNAVAILABLE",
      sanitizedError: "No Telegram bot token or destination is configured.",
    };
  }

  try {
    const response = await fetch(apiUrl("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });

    if (response.ok) {
      return { delivered: true, retryable: false, errorCode: null, sanitizedError: null };
    }

    const { retryable } = classifyStatus(response.status);
    // The status code only — a Telegram error body can echo the request back.
    logger.warn({ status: response.status, retryable }, "Execution Telegram delivery failed");
    return {
      delivered: false,
      retryable,
      errorCode: retryable ? "TELEGRAM_DELIVERY_RETRYABLE" : "TELEGRAM_DELIVERY_PERMANENT_FAILURE",
      sanitizedError: `Telegram responded with HTTP ${response.status}.`,
    };
  } catch {
    // Network-level failure: no status, always worth retrying. The thrown
    // error is not echoed — a fetch error message can contain the full URL,
    // which contains the bot token.
    logger.warn("Execution Telegram delivery threw a transport error");
    return {
      delivered: false,
      retryable: true,
      errorCode: "TELEGRAM_DELIVERY_RETRYABLE",
      sanitizedError: "Telegram could not be reached.",
    };
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
