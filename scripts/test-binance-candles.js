#!/usr/bin/env node
/**
 * Hits Binance's public klines endpoint directly (no local backend endpoint
 * exposes market data — this dashboard only fetches candles internally
 * inside the worker) and prints the parsed candles as a table, so you can
 * sanity-check real Binance data before firing a webhook through the full
 * pipeline.
 *
 * Usage:
 *   node scripts/test-binance-candles.js
 *   node scripts/test-binance-candles.js --symbol ETHUSDT --interval 4h --limit 20
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  BINANCE_REST_BASE_URL: "https://api.binance.com",
};

function readBackendEnv() {
  const envPath = path.join(__dirname, "..", "apps", "backend", ".env");
  const result = { ...DEFAULTS };

  let raw;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch {
    console.warn(`Could not read ${envPath} — falling back to defaults (BINANCE_REST_BASE_URL=https://api.binance.com).`);
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

    if (key === "BINANCE_REST_BASE_URL" && value) result.BINANCE_REST_BASE_URL = value;
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

function parseKlines(raw) {
  return raw.map(([openTimeMs, open, high, low, close, volume]) => ({
    time: Math.floor(Number(openTimeMs) / 1000),
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { BINANCE_REST_BASE_URL } = readBackendEnv();

  const symbol = args.symbol ?? "BTCUSDT";
  const interval = args.interval ?? "1h";
  const limit = args.limit ?? "10";

  const url = `${BINANCE_REST_BASE_URL}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
  console.log(`Fetching: ${url}\n`);

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    console.error(`Request failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const text = await response.text();

  if (!response.ok) {
    console.error(`Binance returned HTTP ${response.status}: ${text}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    console.error("Binance response was not valid JSON:", text);
    process.exit(1);
  }

  const candles = parseKlines(raw);

  console.log(`${symbol} ${interval} — ${candles.length} candle(s):\n`);
  console.table(
    candles.map((c) => ({
      time: new Date(c.time * 1000).toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }))
  );
}

main();
