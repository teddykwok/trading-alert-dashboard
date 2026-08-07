import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 8 boundary guards.
 *
 * Source-level assertions: a future edit that imports a Binance connector into
 * the journal, adds a write route, or starts a worker/poller fails here rather
 * than silently turning an observability page into something that can touch an
 * exchange.
 */

const BACKEND = process.cwd();
const SERVICE = path.join(BACKEND, "src", "modules", "execution", "execution-journal.service.ts");
const ROUTES = path.join(BACKEND, "src", "routes", "executions.routes.ts");
const PHASE_8_FILES = [SERVICE, ROUTES];

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Scans CODE only — the modules document what they must never do. */
function readCode(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(\S)\s\/\/.*$/gm, "$1");
}

describe("read-only journal boundary", () => {
  it("imports no Binance connector or mutation client", () => {
    for (const file of PHASE_8_FILES) {
      const imports = [...readCode(file).matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
      for (const forbidden of [
        "binance.client",
        "binance-read-only.service",
        "binance-execution.client",
        "binance-execution.endpoints",
        "binance.endpoints",
      ]) {
        expect(imports.some((entry) => entry.includes(forbidden)), `${path.basename(file)} imports ${forbidden}`).toBe(
          false
        );
      }
    }
  });

  it("imports no Telegram sender, queue or webhook handler", () => {
    for (const file of PHASE_8_FILES) {
      const source = readCode(file).toLowerCase();
      for (const forbidden of ["telegram", "bullmq", "queue(", "worker(", "webhook", "socket.io", "setinterval"]) {
        expect(`${path.basename(file)}:${source.includes(forbidden)}`).toBe(`${path.basename(file)}:false`);
      }
    }
  });

  it("performs no fetch of any kind", () => {
    for (const file of PHASE_8_FILES) {
      expect(readCode(file)).not.toContain("fetch(");
    }
  });

  it("declares only GET routes", () => {
    const routes = readCode(ROUTES);
    const verbs = [...routes.matchAll(/app\.(get|post|put|patch|delete)\b/g)].map((match) => match[1]);
    expect(verbs.length).toBeGreaterThan(0);
    expect([...new Set(verbs)]).toEqual(["get"]);
  });

  it("writes nothing through Prisma", () => {
    const service = readCode(SERVICE);
    for (const write of [
      ".create(",
      ".createMany(",
      ".update(",
      ".updateMany(",
      ".upsert(",
      ".delete(",
      ".deleteMany(",
      "$executeRaw",
      "$transaction",
    ]) {
      expect(`service:${service.includes(write)}`).toBe("service:false");
    }
  });

  it("uses only read queries", () => {
    const service = readCode(SERVICE);
    const calls = [...service.matchAll(/prisma\.\w+\.(\w+)\(/g)].map((match) => match[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(["findMany", "findUnique", "findFirst", "count"], call).toContain(call);
    }
  });

  it("never returns a Prisma row directly", () => {
    const service = readCode(SERVICE);
    // Every read is mapped through an explicit DTO shape.
    expect(service).toContain("ExecutionListItemDto");
    expect(service).toContain("ExecutionDetailDto");
    expect(service).not.toMatch(/return\s+await\s+this\.prisma\.\w+\.find/);
  });

  it("exposes no account identifier or credential field", () => {
    for (const file of PHASE_8_FILES) {
      const source = readCode(file);
      for (const forbidden of [
        "accountIdentifier",
        "apiKey",
        "apiSecret",
        "BINANCE_API_KEY",
        "TELEGRAM_BOT_TOKEN",
        "walletBalance",
        "availableBalance",
      ]) {
        expect(`${path.basename(file)}:${source.includes(forbidden)}`).toBe(`${path.basename(file)}:false`);
      }
    }
  });

  it("bounds the page size", () => {
    const service = readCode(SERVICE);
    expect(service).toContain("MAX_PAGE_SIZE");
    expect(readCode(ROUTES)).toContain("MAX_PAGE_SIZE");
  });

  it("orders the timeline by sequenceNumber, never by timestamp alone", () => {
    const service = readCode(SERVICE);
    expect(service).toMatch(/orderBy:\s*\{\s*sequenceNumber:\s*"asc"\s*\}/);
    expect(service).not.toMatch(/executionEvent\.findMany\([^)]*orderBy:\s*\{\s*createdAt/);
  });

  it("keeps the live execution gates untouched", () => {
    for (const file of PHASE_8_FILES) {
      const source = readCode(file);
      for (const gate of [
        "EXECUTION_LIVE_ENTRY_ENABLED",
        "EXECUTION_PROTECTION_READY",
        "EXECUTION_AUTO_ADD_MARGIN_ENABLED",
        "EXECUTION_EMERGENCY_CLOSE_MODE",
        "EXECUTION_GLOBAL_KILL_SWITCH",
      ]) {
        expect(`${path.basename(file)}:${source.includes(gate)}`).toBe(`${path.basename(file)}:false`);
      }
    }
  });

  it("still ships the fail-closed gate defaults", () => {
    const envSource = read(path.join(BACKEND, "src", "config", "env.ts"));
    expect(envSource).toMatch(/EXECUTION_LIVE_ENTRY_ENABLED[\s\S]{0,160}?\.default\("false"\)/);
    expect(envSource).toMatch(/EXECUTION_PROTECTION_READY[\s\S]{0,160}?\.default\("false"\)/);
    expect(envSource).toMatch(/EXECUTION_AUTO_ADD_MARGIN_ENABLED[\s\S]{0,160}?\.default\("false"\)/);
    expect(envSource).toMatch(/EXECUTION_EMERGENCY_CLOSE_MODE[\s\S]{0,120}?\.default\("DISABLED"\)/);
  });

  it("leaves the real .env free of Phase 8 overrides", () => {
    let real: string;
    try {
      real = read(path.join(BACKEND, ".env"));
    } catch {
      return;
    }
    expect(real).not.toContain("EXECUTION_LIVE_ENTRY_ENABLED");
    expect(real).not.toContain("EXECUTION_PROTECTION_READY");
  });
});

describe("schema additions", () => {
  const schema = read(path.join(BACKEND, "prisma", "schema.prisma"));

  it("adds both financial fields as nullable decimals", () => {
    expect(schema).toMatch(/tradingFeesUsd\s+Decimal\?\s+@db\.Decimal\(30, 12\)/);
    expect(schema).toMatch(/fundingPnlUsd\s+Decimal\?\s+@db\.Decimal\(30, 12\)/);
  });

  it("adds no raw payload, credential or balance field", () => {
    for (const forbidden of ["rawIncome", "rawBinanceResponse", "walletBalance", "accountSnapshot"]) {
      expect(schema).not.toContain(forbidden);
    }
  });

  it("indexes updatedAt for the default journal ordering", () => {
    expect(schema).toContain("@@index([updatedAt])");
  });
});

describe("app wiring", () => {
  it("registers the journal routes without touching webhook or worker wiring", () => {
    const app = read(path.join(BACKEND, "src", "app.ts"));
    expect(app).toContain("executionsRoutes");
    // The webhook registration is untouched.
    expect(app).toContain("webhookRoutes");
  });

  it("adds no worker or scheduler", () => {
    const app = readCode(path.join(BACKEND, "src", "app.ts"));
    expect(app).not.toContain("ProtectionLifecycleService");
    expect(app).not.toContain("EntryLifecycleService");
    expect(app).not.toContain("SafetyAdmissionService");
  });
});
