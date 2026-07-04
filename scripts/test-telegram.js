#!/usr/bin/env node
/**
 * Sends a single test message to your Telegram chat to verify TELEGRAM_BOT_TOKEN
 * and TELEGRAM_CHAT_ID are correct — independent of the alert pipeline. Reads
 * both values from apps/backend/.env (native fetch only, no dependencies).
 *
 * Usage:
 *   node scripts/test-telegram.js
 *   pnpm test:telegram
 */

const fs = require("node:fs");
const path = require("node:path");

const TEST_MESSAGE = "Trading Alert Dashboard Telegram test message";

function readBackendEnv() {
  const envPath = path.join(__dirname, "..", "apps", "backend", ".env");
  const result = {};

  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    console.error(`Could not read ${envPath}. Create apps/backend/.env first.`);
    process.exit(1);
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

// Show only the tail of the token so we never print the secret in full.
function maskToken(token) {
  if (!token) return "(missing)";
  return token.length <= 6 ? "***" : `***${token.slice(-4)}`;
}

async function main() {
  const env = readBackendEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error("Missing TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID in apps/backend/.env.");
    console.error(`  TELEGRAM_BOT_TOKEN: ${maskToken(token)}`);
    console.error(`  TELEGRAM_CHAT_ID:   ${chatId || "(missing)"}`);
    process.exit(1);
  }

  console.log(`Sending test message to chat ${chatId} using bot token ${maskToken(token)}...`);

  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: TEST_MESSAGE }),
    });
  } catch (error) {
    console.error(`\nRequest failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const body = await response.json().catch(() => undefined);

  if (response.ok && body && body.ok) {
    console.log("\n✅ Success — check your Telegram chat for the test message.");
    return;
  }

  console.error(`\n❌ Telegram API returned status ${response.status}.`);
  if (body && body.description) {
    console.error(`   ${body.description}`);
    if (/chat not found/i.test(body.description)) {
      console.error("   Tip: send a message to your bot first, or double-check TELEGRAM_CHAT_ID.");
    }
    if (/unauthorized/i.test(body.description)) {
      console.error("   Tip: TELEGRAM_BOT_TOKEN looks wrong.");
    }
  }
  process.exit(1);
}

main();
