import { env } from "../../config/env";
import { logger } from "../../config/logger";

const isConfigured = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);

/**
 * Best-effort Telegram notification. Silently no-ops when credentials are
 * not configured so Telegram remains fully optional for local development.
 */
export async function sendTelegramMessage(text: string): Promise<void> {
  if (!isConfigured) return;

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, "Telegram notification failed");
    }
  } catch (error) {
    logger.warn({ error }, "Telegram notification threw an error");
  }
}
