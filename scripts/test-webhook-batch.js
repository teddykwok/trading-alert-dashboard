#!/usr/bin/env node
/**
 * Fires a batch of TradingView-style webhooks at the local backend, one
 * after another, to stress-test queue/worker throughput and dashboard
 * realtime updates. Same dependency-free, native-fetch approach as
 * scripts/test-webhook.js — see that script for the single-request version.
 *
 * Usage:
 *   node scripts/test-webhook-batch.js
 *   node scripts/test-webhook-batch.js --count 20 --delayMs 250
 *   node scripts/test-webhook-batch.js --count 50 --delayMs 100
 *   node scripts/test-webhook-batch.js --symbol BTCUSDT --signal LONG --count 10
 */

const fs = require("node:fs");
const path = require("node:path");

const ENV_DEFAULTS = {
  WEBHOOK_SECRET: "change-me",
  BACKEND_PORT: "4000",
};

const DEFAULT_COUNT = 10;
const DEFAULT_DELAY_MS = 500;

const SYMBOL_ROTATION = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "AAPL", "TSLA"];
const SIGNAL_ROTATION = ["LONG", "SHORT", "WATCH", "EXIT"];

// Reasonable base prices + natural assetType/exchange per rotation symbol,
// used whenever the corresponding CLI flag isn't explicitly provided.
const SYMBOL_PROFILES = {
  BTCUSDT: { basePrice: 64000, assetType: "crypto", exchange: "BINANCE" },
  ETHUSDT: { basePrice: 3500, assetType: "crypto", exchange: "BINANCE" },
  SOLUSDT: { basePrice: 150, assetType: "crypto", exchange: "BINANCE" },
  AAPL: { basePrice: 220, assetType: "stock", exchange: "NASDAQ" },
  TSLA: { basePrice: 250, assetType: "stock", exchange: "NASDAQ" },
};
const FALLBACK_PROFILE = { basePrice: 100, assetType: "crypto", exchange: "BINANCE" };

function readBackendEnv() {
  const envPath = path.join(__dirname, "..", "apps", "backend", ".env");
  const result = { ...ENV_DEFAULTS };

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
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Small +/-1% jitter so repeated batch prices aren't all identical. */
function jitteredPrice(basePrice) {
  const jitter = 1 + (Math.random() - 0.5) * 0.02;
  return Math.round(basePrice * jitter * 100) / 100;
}

function buildPayload(secret, args, index) {
  const symbol = args.symbol ?? SYMBOL_ROTATION[index % SYMBOL_ROTATION.length];
  const signal = args.signal ?? SIGNAL_ROTATION[index % SIGNAL_ROTATION.length];
  const profile = SYMBOL_PROFILES[symbol] ?? FALLBACK_PROFILE;

  const price = args.price !== undefined ? Number(args.price) : jitteredPrice(profile.basePrice);
  const assetType = args.assetType ?? profile.assetType;
  const exchange = args.exchange ?? profile.exchange;

  return {
    secret,
    symbol,
    assetType,
    timeframe: args.timeframe ?? "1h",
    price,
    signal,
    indicatorName: "My Custom Indicator",
    indicatorValue: 87.2,
    triggeredAt: new Date().toISOString(),
    exchange,
    note: `Batch webhook stress test #${index + 1}`,
  };
}

function padRight(value, width) {
  return String(value).padEnd(width);
}

async function sendOne(webhookUrl, payload, index) {
  const startedAt = performance.now();

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const elapsedMs = Math.round(performance.now() - startedAt);
    const text = await response.text();

    let alertId = "";
    let errorMessage = "";
    try {
      const parsed = JSON.parse(text);
      alertId = parsed.id ?? "";
      if (!response.ok) errorMessage = parsed.message ?? text;
    } catch {
      if (!response.ok) errorMessage = text;
    }

    const ok = response.ok;
    console.log(
      `[${padRight(index + 1, 3)}] ${padRight(payload.symbol, 8)} ${padRight(payload.signal, 6)} ${padRight(payload.price, 10)} -> ${response.status}` +
        `${alertId ? `  id=${alertId}` : ""}${errorMessage ? `  error="${errorMessage}"` : ""}  ${elapsedMs}ms`
    );

    return { index, ok, status: response.status, elapsedMs, symbol: payload.symbol, signal: payload.signal, errorMessage };
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const message = error instanceof Error ? error.message : String(error);

    console.log(
      `[${padRight(index + 1, 3)}] ${padRight(payload.symbol, 8)} ${padRight(payload.signal, 6)} ${padRight(payload.price, 10)} -> REQUEST FAILED (${message})  ${elapsedMs}ms`
    );

    return { index, ok: false, status: null, elapsedMs, symbol: payload.symbol, signal: payload.signal, errorMessage: message };
  }
}

function printSummary(results) {
  const total = results.length;
  const successes = results.filter((r) => r.ok);
  const failures = results.filter((r) => !r.ok);
  const times = results.map((r) => r.elapsedMs);

  const avg = times.length ? Math.round(times.reduce((sum, t) => sum + t, 0) / times.length) : 0;
  const min = times.length ? Math.min(...times) : 0;
  const max = times.length ? Math.max(...times) : 0;

  console.log("\n--- Batch summary ---");
  console.log(`Total sent:       ${total}`);
  console.log(`Successful:       ${successes.length}`);
  console.log(`Failed:           ${failures.length}`);
  console.log(`Avg response time: ${avg}ms`);
  console.log(`Min response time: ${min}ms`);
  console.log(`Max response time: ${max}ms`);

  if (failures.length > 0) {
    console.log("\nFailed requests:");
    for (const f of failures) {
      const statusLabel = f.status === null ? "no response" : f.status;
      console.log(`  [${f.index + 1}] ${f.symbol} ${f.signal} -> ${statusLabel}${f.errorMessage ? ` (${f.errorMessage})` : ""}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { WEBHOOK_SECRET, BACKEND_PORT } = readBackendEnv();

  const count = args.count !== undefined ? Number(args.count) : DEFAULT_COUNT;
  const delayMs = args.delayMs !== undefined ? Number(args.delayMs) : DEFAULT_DELAY_MS;
  const webhookUrl = `http://localhost:${BACKEND_PORT}/api/webhooks/tradingview`;

  console.log(`Webhook URL: ${webhookUrl}`);
  console.log(`Sending ${count} request(s) with ${delayMs}ms delay between each...\n`);

  const results = [];
  for (let i = 0; i < count; i += 1) {
    const payload = buildPayload(WEBHOOK_SECRET, args, i);
    const result = await sendOne(webhookUrl, payload, i);
    results.push(result);

    if (i < count - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  printSummary(results);

  const anyFailed = results.some((r) => !r.ok);
  if (anyFailed) {
    console.log("\nBatch completed with failures. Check backend/worker logs.");
    process.exit(1);
  }

  console.log("\nBatch completed successfully. Check dashboard and worker logs.");
}

main();
