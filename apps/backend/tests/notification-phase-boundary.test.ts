import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 9 boundary guards and configuration behaviour.
 *
 * Source-level assertions: a future edit that imports a Binance connector into
 * the notification pipeline, writes to a TradeExecution, starts a daemon or
 * accepts a Telegram reply as a command fails here rather than silently turning
 * an observability feature into something that can move money.
 */

const BACKEND = process.cwd();
const PURE = path.join(BACKEND, "src", "modules", "notifications", "execution-notification.ts");
const FORMAT = path.join(BACKEND, "src", "modules", "notifications", "execution-notification-format.ts");
const SERVICE = path.join(BACKEND, "src", "modules", "notifications", "execution-notification.service.ts");
const TRANSPORT = path.join(BACKEND, "src", "modules", "notifications", "telegram.service.ts");
const PHASE_9_FILES = [PURE, FORMAT, SERVICE];

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** Scans CODE only — the modules document at length what they must never do. */
function readCode(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(\S)\s\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// Phase boundary
// ---------------------------------------------------------------------------

describe("notification pipeline boundary", () => {
  it("imports no Binance connector, read client or mutation client", () => {
    for (const file of PHASE_9_FILES) {
      const imports = [...readCode(file).matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
      for (const forbidden of [
        "binance.client",
        "binance-read-only",
        "binance-execution.client",
        "binance-execution.endpoints",
        "binance-algo",
        "binance.endpoints",
        "market-data",
      ]) {
        expect(
          imports.some((entry) => entry.includes(forbidden)),
          `${path.basename(file)} imports ${forbidden}`
        ).toBe(false);
      }
    }
  });

  it("imports no lifecycle service that could transition an execution", () => {
    for (const file of PHASE_9_FILES) {
      const imports = [...readCode(file).matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
      for (const forbidden of [
        "entry-lifecycle",
        "protection-lifecycle",
        "safety-admission",
        "execution.service",
        "webhook",
      ]) {
        expect(
          imports.some((entry) => entry.includes(forbidden)),
          `${path.basename(file)} imports ${forbidden}`
        ).toBe(false);
      }
    }
  });

  it("performs no fetch outside the transport module", () => {
    for (const file of PHASE_9_FILES) {
      expect(`${path.basename(file)}:${readCode(file).includes("fetch(")}`).toBe(`${path.basename(file)}:false`);
    }
  });

  it("never writes to an execution, order, protection state or event", () => {
    const service = readCode(SERVICE);
    for (const forbidden of [
      "tradeExecution.create",
      "tradeExecution.update",
      "tradeExecution.updateMany",
      "tradeExecution.upsert",
      "tradeExecution.delete",
      "tradeExecution.deleteMany",
      "binanceOrder.create",
      "binanceOrder.update",
      "binanceOrder.delete",
      "executionProtectionState.create",
      "executionProtectionState.update",
      "executionProtectionState.delete",
      "executionEvent.create",
      "executionEvent.update",
      "executionEvent.delete",
      "marginAdjustmentIntent.create",
      "marginAdjustmentIntent.update",
      "safetyAdmission.create",
      "$executeRaw",
    ]) {
      expect(`${forbidden}:${service.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("only ever reads execution state", () => {
    const service = readCode(SERVICE);
    const executionCalls = [...service.matchAll(/prisma\.(tradeExecution|binanceOrder|executionEvent|executionProtectionState|safetyAdmission)\.(\w+)\(/g)];
    expect(executionCalls.length).toBeGreaterThan(0);
    for (const [, model, call] of executionCalls) {
      expect(["findMany", "findUnique", "findFirst", "findUniqueOrThrow", "count"], `${model}.${call}`).toContain(call);
    }
  });

  it("writes only to its own outbox and the Phase 7 critical alert delivery fields", () => {
    const service = readCode(SERVICE);
    // Phase 7 owns the critical record: Phase 9 may only deliver it.
    for (const forbidden of ["criticalAlert.create", "criticalAlert.delete", "criticalAlert.upsert"]) {
      expect(`${forbidden}:${service.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    expect(service).toContain("executionNotification.create");

    // Every field written to a CriticalAlert is a delivery field. The Phase 7
    // dedupe identity, alert type, reason code and message are never rewritten.
    const criticalWrites = [...service.matchAll(/criticalAlert\.update(?:Many)?\(\{[\s\S]*?data:\s*\{([\s\S]*?)\}/g)];
    expect(criticalWrites.length).toBeGreaterThan(0);
    // "increment" is the nested operator of `attempts: { increment: 1 }`.
    const allowed = ["status", "sentAt", "attempts", "increment", "lastError", "claimedAt", "claimOwner"];
    for (const [, block] of criticalWrites) {
      for (const [, field] of block.matchAll(/(\w+):/g)) {
        expect(allowed, field).toContain(field);
      }
    }
  });

  it("holds no transaction across a Telegram call", () => {
    const service = readCode(SERVICE);
    // Transactions exist only to commit notification intents together with
    // their discovery checkpoint. None of them may contain a send: an HTTP call
    // inside a transaction would hold database locks for the length of a
    // Telegram round trip, and a Telegram timeout would roll back durable work.
    const blocks = [...service.matchAll(/\$transaction\(async \(tx\) => \{([\s\S]*?)\n {4}\}\)/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, body] of blocks) {
      for (const forbidden of ["this.sender", "safeSend", "deliverNotification", "deliverCritical", "fetch("]) {
        expect(`${forbidden}:${body.includes(forbidden)}`).toBe(`${forbidden}:false`);
      }
    }

    // And delivery itself never opens one.
    const deliverySection = service.slice(service.indexOf("async dispatchPendingNotifications"));
    const beforeDiscovery = deliverySection.slice(0, deliverySection.indexOf("async materializeFromEvents"));
    expect(beforeDiscovery).not.toContain("$transaction");
  });

  it("adds no worker, scheduler, poller or perpetual loop", () => {
    for (const file of [...PHASE_9_FILES, TRANSPORT]) {
      const source = readCode(file).toLowerCase();
      for (const forbidden of ["setinterval", "settimeout", "new worker", "bullmq", "queue(", "while (true)", "cron"]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("reads no Telegram update and interprets no reply as a command", () => {
    for (const file of [...PHASE_9_FILES, TRANSPORT]) {
      const source = readCode(file);
      for (const forbidden of ["getUpdates", "setWebhook", "answerCallbackQuery", "reply_markup", "inline_keyboard"]) {
        expect(`${path.basename(file)}:${forbidden}:${source.includes(forbidden)}`).toBe(
          `${path.basename(file)}:${forbidden}:false`
        );
      }
    }
  });

  it("touches none of the live execution gates", () => {
    for (const file of PHASE_9_FILES) {
      const source = readCode(file);
      for (const gate of [
        "EXECUTION_LIVE_ENTRY_ENABLED",
        "EXECUTION_PROTECTION_READY",
        "EXECUTION_AUTO_ADD_MARGIN_ENABLED",
        "EXECUTION_EMERGENCY_CLOSE_MODE",
        "EXECUTION_GLOBAL_KILL_SWITCH",
      ]) {
        expect(`${path.basename(file)}:${gate}:${source.includes(gate)}`).toBe(`${path.basename(file)}:${gate}:false`);
      }
    }
  });

  it("registers no route and no HTTP control surface", () => {
    const app = read(path.join(BACKEND, "src", "app.ts"));
    for (const forbidden of ["notificationRoutes", "execution-notification", "telegramRoutes"]) {
      expect(`${forbidden}:${app.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("still ships the fail-closed gate defaults", () => {
    const envSource = read(path.join(BACKEND, "src", "config", "env.ts"));
    expect(envSource).toMatch(/EXECUTION_LIVE_ENTRY_ENABLED[\s\S]{0,160}?\.default\("false"\)/);
    expect(envSource).toMatch(/EXECUTION_PROTECTION_READY[\s\S]{0,160}?\.default\("false"\)/);
    expect(envSource).toMatch(/EXECUTION_AUTO_ADD_MARGIN_ENABLED[\s\S]{0,160}?\.default\("false"\)/);
    expect(envSource).toMatch(/EXECUTION_EMERGENCY_CLOSE_MODE[\s\S]{0,120}?\.default\("DISABLED"\)/);
  });
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("outbox schema", () => {
  const schema = read(path.join(BACKEND, "prisma", "schema.prisma"));

  it("keeps financial history with Restrict", () => {
    expect(schema).toMatch(/model ExecutionNotification[\s\S]*?onDelete: Restrict/);
  });

  it("enforces dedupe with a database uniqueness constraint", () => {
    expect(schema).toMatch(/model ExecutionNotification[\s\S]*?dedupeKey\s+String\s+@unique/);
  });

  it("stores no credential, chat id, balance or raw payload column", () => {
    const model = /model ExecutionNotification \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(model.length).toBeGreaterThan(0);
    for (const forbidden of ["botToken", "chatId", "rawRequest", "rawResponse", "authorization", "balance", "apiKey"]) {
      expect(`${forbidden}:${model.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("keeps CRITICAL_PROTECTION_FAILURE out of the informational enum", () => {
    const enumBlock = /enum ExecutionNotificationType \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(enumBlock).not.toContain("CRITICAL_PROTECTION_FAILURE");
    // Phase 7's model is still the one durable critical record.
    expect(schema).toContain("model CriticalAlert");
  });
});

describe("migrations", () => {
  const directory = path.join(BACKEND, "prisma", "migrations", "20260807190000_add_execution_notification_outbox");
  const sql = read(path.join(directory, "migration.sql"));

  it("is additive only", () => {
    for (const destructive of ["DROP TABLE", "DROP COLUMN", "TRUNCATE", "DELETE FROM", "DROP TYPE"]) {
      expect(`${destructive}:${sql.toUpperCase().includes(destructive)}`).toBe(`${destructive}:false`);
    }
  });

  it("seeds nothing", () => {
    expect(sql.toUpperCase()).not.toContain("INSERT INTO");
  });

  it("adds only nullable delivery-lease columns to the Phase 7 table", () => {
    const alter = /ALTER TABLE "CriticalAlert"[\s\S]*?;/.exec(sql)?.[0] ?? "";
    expect(alter).toContain("claimedAt");
    expect(alter).toContain("claimOwner");
    expect(alter).not.toContain("NOT NULL");
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Loads config + transport fresh under a scripted environment. */
async function withEnv<T>(overrides: Record<string, string>, run: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  vi.resetModules();
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  }
}

afterEach(() => {
  vi.resetModules();
});

describe("execution chat configuration", () => {
  it("uses the dedicated execution chat when one is configured", async () => {
    await withEnv({ TELEGRAM_CHAT_ID: "-1008888", TELEGRAM_EXECUTION_CHAT_ID: "-1009999" }, async () => {
      const transport = await import("../src/modules/notifications/telegram.service");
      expect(transport.resolveExecutionChatId()).toBe("-1009999");
    });
  });

  it("falls back to the existing chat when the execution chat is empty", async () => {
    await withEnv({ TELEGRAM_CHAT_ID: "-1008888", TELEGRAM_EXECUTION_CHAT_ID: "" }, async () => {
      const transport = await import("../src/modules/notifications/telegram.service");
      expect(transport.resolveExecutionChatId()).toBe("-1008888");
    });
  });

  it("resolves to null when nothing at all is configured", async () => {
    await withEnv({ TELEGRAM_CHAT_ID: "", TELEGRAM_EXECUTION_CHAT_ID: "" }, async () => {
      const transport = await import("../src/modules/notifications/telegram.service");
      expect(transport.resolveExecutionChatId()).toBeNull();
      expect(transport.resolveCriticalChatId()).toBeNull();
    });
  });

  it("keeps critical alerts on the existing destination, never duplicated", async () => {
    await withEnv({ TELEGRAM_CHAT_ID: "-1008888", TELEGRAM_EXECUTION_CHAT_ID: "-1009999" }, async () => {
      const transport = await import("../src/modules/notifications/telegram.service");
      // One critical message goes to exactly one chat.
      expect(transport.resolveCriticalChatId()).toBe("-1008888");
      expect(transport.resolveCriticalChatId()).not.toBe(transport.resolveExecutionChatId());
    });
  });

  it("rejects a malformed execution chat id at startup", async () => {
    await withEnv({ TELEGRAM_EXECUTION_CHAT_ID: "not a chat id" }, async () => {
      await expect(import("../src/config/env")).rejects.toThrow(/Invalid environment variables/);
    });
  });

  it("accepts the documented chat id shapes", async () => {
    for (const value of ["-1001234567890", "123456789", "@my_public_channel"]) {
      await withEnv({ TELEGRAM_EXECUTION_CHAT_ID: value }, async () => {
        const { env } = await import("../src/config/env");
        expect(env.TELEGRAM_EXECUTION_CHAT_ID, value).toBe(value);
      });
    }
  });

  it("defaults to empty so an existing deployment is unaffected", async () => {
    await withEnv({}, async () => {
      const previous = process.env.TELEGRAM_EXECUTION_CHAT_ID;
      delete process.env.TELEGRAM_EXECUTION_CHAT_ID;
      try {
        const { env } = await import("../src/config/env");
        expect(env.TELEGRAM_EXECUTION_CHAT_ID).toBe("");
      } finally {
        if (previous !== undefined) process.env.TELEGRAM_EXECUTION_CHAT_ID = previous;
      }
    });
  });

  it("introduces no second bot token", () => {
    const envSource = read(path.join(BACKEND, "src", "config", "env.ts"));
    const tokens = [...envSource.matchAll(/TELEGRAM\w*TOKEN\w*/g)].map((match) => match[0]);
    expect(new Set(tokens)).toEqual(new Set(["TELEGRAM_BOT_TOKEN"]));
  });

  it("keeps the token environment-only and out of every Phase 9 module", () => {
    for (const file of PHASE_9_FILES) {
      expect(`${path.basename(file)}:${read(file).includes("TELEGRAM_BOT_TOKEN")}`).toBe(
        `${path.basename(file)}:false`
      );
    }
  });

  it("never logs a chat id", () => {
    const transport = readCode(TRANSPORT);
    const service = readCode(SERVICE);
    // Every logger call is inspected for a chat-id-bearing field.
    for (const source of [transport, service]) {
      for (const call of [...source.matchAll(/logger\.\w+\(([\s\S]{0,200}?)\)/g)].map((match) => match[1])) {
        expect(call.toLowerCase()).not.toContain("chatid");
        expect(call).not.toContain("chat_id");
        expect(call.toLowerCase()).not.toContain("destination.");
      }
    }
  });

  it("documents both example environment files without touching the real one", () => {
    for (const example of [path.join(BACKEND, ".env.example"), path.join(BACKEND, "..", "..", ".env.example")]) {
      expect(read(example)).toContain("TELEGRAM_EXECUTION_CHAT_ID=");
    }

    let real: string;
    try {
      real = read(path.join(BACKEND, ".env"));
    } catch {
      return;
    }
    // Phase 9 adds nothing to the real environment.
    expect(real).not.toContain("TELEGRAM_EXECUTION_CHAT_ID");
    expect(real).not.toContain("EXECUTION_LIVE_ENTRY_ENABLED");
    expect(real).not.toContain("EXECUTION_PROTECTION_READY");
  });
});

// ---------------------------------------------------------------------------
// Existing notifications
// ---------------------------------------------------------------------------

describe("existing Telegram behaviour", () => {
  it("leaves the signal and Extreme RR senders untouched", () => {
    const transport = read(TRANSPORT);
    // The pre-Phase-9 entry points still exist with their original signatures.
    expect(transport).toMatch(/export async function sendTelegramMessage\(text: string\)/);
    expect(transport).toMatch(/export async function sendTelegramPhoto\(imagePath: string, caption: string\)/);
    // And they still send to the original destination.
    expect(transport).toMatch(/chat_id: env\.TELEGRAM_CHAT_ID/);
  });

  it("keeps execution messages visually distinct from signal messages", () => {
    const executionHeadings = read(FORMAT).match(/"[^"]*(LIMIT PLACED|POSITION FILLED|CLOSED —|TRADE SKIPPED)[^"]*"/g) ?? [];
    expect(executionHeadings.length).toBeGreaterThan(0);
    const signalSource = read(path.join(BACKEND, "src", "modules", "notifications", "extreme-rr-telegram.ts"));
    for (const heading of executionHeadings) {
      expect(signalSource).not.toContain(heading);
    }
  });

  it("sends plain text, matching the repository convention", () => {
    const transport = readCode(TRANSPORT);
    // No parse_mode anywhere: nothing dynamic can break a Telegram parser.
    expect(transport).not.toContain("parse_mode");
    expect(readCode(FORMAT)).not.toContain("parse_mode");
  });
});
