#!/usr/bin/env node
/**
 * Fires a test TradingView-style webhook at the local backend without
 * needing curl (PowerShell aliases `curl` to Invoke-WebRequest, which makes
 * JSON body escaping painful). Reads WEBHOOK_SECRET / BACKEND_PORT from
 * apps/backend/.env so it stays in sync with your local config.
 *
 * Usage:
 *   node scripts/test-webhook.js
 *   node scripts/test-webhook.js --symbol ETHUSDT --signal SHORT --price 3500 --timeframe 4h
 *   node scripts/test-webhook.js --symbol AAPL --assetType stock --signal WATCH --price 220 --exchange NASDAQ
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  WEBHOOK_SECRET: "change-me",
  BACKEND_PORT: "4000",
};

function readBackendEnv() {
  const envPath = path.join(__dirname, "..", "apps", "backend", ".env");
  const result = { ...DEFAULTS };

  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    console.warn(`Could not read ${envPath} — falling back to defaults (WEBHOOK_SECRET=change-me, BACKEND_PORT=4000).`);
    return result;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Strip matching surrounding quotes, if any.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key === "WEBHOOK_SECRET" && value) result.WEBHOOK_SECRET = value;
    if (key === "BACKEND_PORT" && value) result.BACKEND_PORT = value;
  }

  return result;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;

    const key = token.slice(2);
    const next = argv[i + 1];

    if (next === undefined || next.startsWith("--")) {
      args[key] = true; // boolean flag with no value
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function buildPayload(secret, args) {
  return {
    secret,
    symbol: args.symbol ?? "BTCUSDT",
    assetType: args.assetType ?? "crypto",
    timeframe: args.timeframe ?? "1h",
    price: args.price !== undefined ? Number(args.price) : 64250.5,
    signal: args.signal ?? "LONG",
    indicatorName: args.indicatorName ?? "My Custom Indicator",
    indicatorValue: args.indicatorValue !== undefined ? Number(args.indicatorValue) : 87.2,
    triggeredAt: new Date().toISOString(),
    exchange: args.exchange ?? "BINANCE",
    note: args.note ?? "Local Node.js webhook test",
  };
}

function maskSecret(payload) {
  return { ...payload, secret: "***" };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { WEBHOOK_SECRET, BACKEND_PORT } = readBackendEnv();

  const webhookUrl = `http://localhost:${BACKEND_PORT}/api/webhooks/tradingview`;
  const payload = buildPayload(WEBHOOK_SECRET, args);

  console.log(`Webhook URL: ${webhookUrl}`);
  console.log("Payload:", JSON.stringify(maskSecret(payload), null, 2));

  let response;
  try {
    response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error(`\nRequest failed: ${error instanceof Error ? error.message : error}`);
    console.error("Is the backend running? Try `pnpm dev:backend` first.");
    process.exit(1);
  }

  const text = await response.text();
  let bodyForLog = text;
  try {
    bodyForLog = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Not JSON — print the raw text as-is.
  }

  console.log(`\nHTTP status: ${response.status}`);
  console.log("Response body:", bodyForLog || "(empty)");

  if (!response.ok) {
    console.error("\nWebhook test failed.");
    process.exit(1);
  }

  console.log("\nWebhook test successful. Check dashboard and worker logs.");
}

main();
