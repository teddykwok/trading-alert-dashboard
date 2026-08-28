import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CHART_BROWSER_CLOSE_TIMEOUT_MS,
  CHART_BROWSER_LAUNCH_TIMEOUT_MS,
  CHART_RENDER_DEADLINE_MS,
  CHART_STEP_TIMEOUT_MS,
  ChartRenderTimeoutError,
  renderChartScreenshot,
  type ChartBrowser,
  type ChartPage,
  type RenderChartInput,
} from "../src/modules/chart-renderer/chart-renderer.service";

/**
 * Bounding the vision job so a hang cannot stop the alert pipeline.
 *
 * ## The hazard, precisely
 *
 * The vision worker runs `concurrency: 2`. BullMQ does NOT rescue a job that
 * hangs while its process is still alive: `lock-manager.js` renews a running
 * job's lock on a timer that is independent of whether the processor promise
 * ever settles, so a hung-but-alive job keeps renewing its own lock and is
 * never treated as stalled. Stalled detection only catches jobs whose lock
 * EXPIRED — that is, jobs whose process died.
 *
 * So two hung renders occupy both slots permanently, and every subsequent
 * alert waits forever, while the worker process stays healthy and keeps
 * attesting. Worker supervision cannot help: the worker is not dead.
 *
 * ## What was actually unbounded
 *
 * `page.evaluate()` accepts no options at all — no timeout, and
 * `setDefaultTimeout` explicitly only covers "methods accepting a timeout
 * option". `browser.close()` is the same, which meant the cleanup `finally`
 * could hang too. Playwright's implicit 30s defaults covered everything else.
 *
 * ## Why these tests use a fake browser
 *
 * A hang has to be *observed*, and observing a real 60s deadline would mean a
 * 60s test. The renderer takes an injectable `launch`, so the fake can hang on
 * exactly the operation that used to be unbounded, with the deadlines dialled
 * down — the production constants are asserted separately.
 */

const CHART_PATH = path.resolve(__dirname, "../src/modules/chart-renderer/chart-renderer.service.ts");
const CHART_SOURCE = readFileSync(CHART_PATH, "utf8");
const WORKER_SOURCE = readFileSync(
  path.resolve(__dirname, "../src/modules/jobs/vision-analysis.worker.ts"),
  "utf8"
);
const OPENAI_SOURCE = readFileSync(
  path.resolve(__dirname, "../src/modules/ai-vision/openai.provider.ts"),
  "utf8"
);

/**
 * Source with its comments removed.
 *
 * The structural bans below are about what the CODE does, and the comments
 * legitimately discuss the very things being banned — this module explains at
 * length why it must not retry internally. Scanning raw text would turn an
 * accurate explanation into a failure and push the next author towards
 * deleting the explanation rather than keeping the property.
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const CHART_CODE = codeOf(CHART_SOURCE);

const PNG = Buffer.from("fake-png");

const input: RenderChartInput = {
  candles: [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }] as never,
  price: 1.5,
  symbol: "TESTUSDT",
  timeframe: "15m",
  signal: "LONG",
};

/** A promise that never settles — the hang, made explicit. */
const forever = <T>() => new Promise<T>(() => {});

interface FakeOptions {
  /** Which step hangs, if any. */
  hangAt?: "newPage" | "evaluate" | "screenshot" | "close";
  /** Records what the renderer did to this browser. */
  trace?: string[];
}

function fakeBrowser(options: FakeOptions = {}) {
  const trace = options.trace ?? [];
  let closed = 0;
  let defaultTimeout: number | null = null;

  const page: ChartPage = {
    setDefaultTimeout(timeout) {
      defaultTimeout = timeout;
      trace.push(`setDefaultTimeout:${timeout}`);
    },
    async goto() {
      trace.push("goto");
    },
    async addScriptTag() {
      trace.push("addScriptTag");
    },
    async evaluate() {
      trace.push("evaluate");
      if (options.hangAt === "evaluate") return forever();
    },
    async waitForFunction() {
      trace.push("waitForFunction");
    },
    async waitForTimeout() {
      trace.push("waitForTimeout");
    },
    locator() {
      return {
        async screenshot() {
          trace.push("screenshot");
          if (options.hangAt === "screenshot") return forever<Buffer>();
          return PNG;
        },
      };
    },
  };

  const browser: ChartBrowser = {
    async newPage() {
      trace.push("newPage");
      if (options.hangAt === "newPage") return forever<ChartPage>();
      return page;
    },
    async close() {
      closed += 1;
      trace.push("close");
      if (options.hangAt === "close") return forever<void>();
    },
  };

  return {
    browser,
    trace,
    get closeCount() {
      return closed;
    },
    get defaultTimeout() {
      return defaultTimeout;
    },
  };
}

/** Fast deadlines, so a hang is observed in milliseconds rather than a minute. */
const fast = {
  renderDeadlineMs: 40,
  closeTimeoutMs: 20,
  stepTimeoutMs: 30,
  launchTimeoutMs: 50,
};

// ===========================================================================
// A. The healthy path is unchanged
// ===========================================================================

describe("A. a render that finishes before its deadline", () => {
  it("returns the screenshot and performs every step in order", async () => {
    const fake = fakeBrowser();
    const buffer = await renderChartScreenshot(input, { ...fast, launch: async () => fake.browser });

    expect(buffer).toBe(PNG);
    expect(fake.trace).toEqual([
      "newPage",
      `setDefaultTimeout:${fast.stepTimeoutMs}`,
      "goto",
      "addScriptTag",
      "evaluate",
      "waitForFunction",
      "waitForTimeout",
      "screenshot",
      "close",
    ]);
  });

  it("still disposes of its browser on success", async () => {
    const fake = fakeBrowser();
    await renderChartScreenshot(input, { ...fast, launch: async () => fake.browser });
    expect(fake.closeCount).toBe(1);
  });

  it("passes the launch deadline to Chromium instead of relying on the implicit one", async () => {
    const seen: { timeout: number }[] = [];
    const fake = fakeBrowser();
    await renderChartScreenshot(input, {
      ...fast,
      launch: async (launchOptions) => {
        seen.push(launchOptions);
        return fake.browser;
      },
    });
    expect(seen).toEqual([{ timeout: fast.launchTimeoutMs }]);
  });

  it("applies ONE explicit step ceiling rather than four inherited defaults", async () => {
    const fake = fakeBrowser();
    await renderChartScreenshot(input, { ...fast, launch: async () => fake.browser });
    expect(fake.defaultTimeout).toBe(fast.stepTimeoutMs);
  });
});

// ===========================================================================
// B. A hung render is bounded, and its resources are disposed
// ===========================================================================

describe("B. a hung render times out and disposes what it owns", () => {
  it("bounds page.evaluate — the operation Playwright cannot time out at all", async () => {
    const fake = fakeBrowser({ hangAt: "evaluate" });

    await expect(
      renderChartScreenshot(input, { ...fast, launch: async () => fake.browser })
    ).rejects.toBeInstanceOf(ChartRenderTimeoutError);

    // The disposal is the whole point: closing the browser terminates the
    // Chromium process, which is what actually aborts the hung evaluate.
    expect(fake.closeCount).toBe(1);
  });

  it("bounds a hang in any other owned step too", async () => {
    for (const hangAt of ["newPage", "screenshot"] as const) {
      const fake = fakeBrowser({ hangAt });
      await expect(
        renderChartScreenshot(input, { ...fast, launch: async () => fake.browser }),
        hangAt
      ).rejects.toBeInstanceOf(ChartRenderTimeoutError);
      expect(fake.closeCount, hangAt).toBe(1);
    }
  });

  it("reports the timeout with its budget and no path or URL", async () => {
    const fake = fakeBrowser({ hangAt: "evaluate" });
    const seen: { stage: string; timeoutMs: number }[] = [];

    await renderChartScreenshot(input, {
      ...fast,
      launch: async () => fake.browser,
      onTimeout: (detail) => seen.push(detail),
    }).catch((error: ChartRenderTimeoutError) => {
      expect(error.code).toBe("CHART_RENDER_TIMEOUT");
      expect(error.timeoutMs).toBe(fast.renderDeadlineMs);
      expect(error.message).toContain(`${fast.renderDeadlineMs}ms`);
      expect(error.message).not.toMatch(/file:\/\/|[A-Za-z]:\\|\/home\//);
    });

    expect(seen.map((entry) => entry.stage)).toContain("RENDER");
  });

  it("a close that hangs cannot hang the caller — the finally is bounded too", async () => {
    // Without this the cleanup path becomes the very stall it exists to
    // prevent: browser.close() has no timeout parameter of its own.
    const fake = fakeBrowser({ hangAt: "close" });
    const seen: string[] = [];

    const started = Date.now();
    const buffer = await renderChartScreenshot(input, {
      ...fast,
      launch: async () => fake.browser,
      onTimeout: (detail) => seen.push(detail.stage),
    });

    expect(buffer).toBe(PNG);
    expect(seen).toContain("CLOSE");
    // It returned rather than hanging; the bound is what makes that true.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("leaves no timer holding the event loop open", async () => {
    // Every deadline clears its own timer, on success and on failure alike.
    const clearSpy = vi.spyOn(global, "clearTimeout");
    const before = clearSpy.mock.calls.length;

    const ok = fakeBrowser();
    await renderChartScreenshot(input, { ...fast, launch: async () => ok.browser });

    const hung = fakeBrowser({ hangAt: "evaluate" });
    await renderChartScreenshot(input, { ...fast, launch: async () => hung.browser }).catch(() => {});

    // Two calls x (render guard + close guard).
    expect(clearSpy.mock.calls.length - before).toBeGreaterThanOrEqual(4);
    clearSpy.mockRestore();
  });
});

// ===========================================================================
// C/J. Isolation between concurrent jobs
// ===========================================================================

describe("C. one job's timeout never touches another job's resources", () => {
  it("each render owns its own browser, so disposal cannot cross jobs", async () => {
    const hung = fakeBrowser({ hangAt: "evaluate" });
    const healthy = fakeBrowser();

    const hungRun = renderChartScreenshot(input, { ...fast, launch: async () => hung.browser }).catch(
      (error) => error
    );
    const healthyRun = renderChartScreenshot(input, {
      ...fast,
      // A generous deadline: this one must survive the other's timeout.
      renderDeadlineMs: 5_000,
      launch: async () => healthy.browser,
    });

    const [hungResult, healthyResult] = await Promise.all([hungRun, healthyRun]);

    expect(hungResult).toBeInstanceOf(ChartRenderTimeoutError);
    expect(healthyResult).toBe(PNG);
    // The healthy job closed its own browser exactly once, when IT finished.
    expect(healthy.closeCount).toBe(1);
    expect(hung.closeCount).toBe(1);
    expect(healthy.browser).not.toBe(hung.browser);
  });

  it("there is no shared or module-level browser to close by mistake", () => {
    // The launch happens inside the function, per call. A module-level browser
    // would make the unconditional close in `finally` unsafe.
    expect(CHART_SOURCE).toContain("const browser = await launch({ timeout: launchTimeoutMs });");
    expect(CHART_SOURCE).not.toMatch(/^(let|const)\s+sharedBrowser/m);
    expect(CHART_SOURCE).not.toMatch(/browser\s*\?\?=|cachedBrowser/);
  });
});

describe("J/I. two hung jobs do not permanently consume concurrency = 2", () => {
  it("both slots are released, and a third job then runs", async () => {
    // The exact failure mode this feature exists to prevent, modelled as a
    // semaphore of size 2 over the real renderer.
    const CONCURRENCY = 2;
    let inFlight = 0;
    let peak = 0;
    const completed: string[] = [];

    async function runJob(name: string, fake: ReturnType<typeof fakeBrowser>, deadlineMs: number) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await renderChartScreenshot(input, {
          ...fast,
          renderDeadlineMs: deadlineMs,
          launch: async () => fake.browser,
        });
        completed.push(`${name}:ok`);
      } catch (error) {
        completed.push(`${name}:${error instanceof ChartRenderTimeoutError ? "timeout" : "error"}`);
      } finally {
        inFlight -= 1;
      }
    }

    const hungA = fakeBrowser({ hangAt: "evaluate" });
    const hungB = fakeBrowser({ hangAt: "evaluate" });
    const healthyC = fakeBrowser();

    // Slots 1 and 2 both hang.
    await Promise.all([runJob("A", hungA, 30), runJob("B", hungB, 30)]);
    expect(inFlight).toBe(0); // both slots freed

    // Slot is now available for the next job.
    await runJob("C", healthyC, 5_000);

    expect(completed).toEqual(["A:timeout", "B:timeout", "C:ok"]);
    expect(peak).toBeLessThanOrEqual(CONCURRENCY);
    // Every browser was disposed — nothing leaked into the next job.
    expect([hungA.closeCount, hungB.closeCount, healthyC.closeCount]).toEqual([1, 1, 1]);
  });
});

// ===========================================================================
// D/E. The AI request is bounded across its WHOLE exchange
// ===========================================================================

describe("D/E. the AI provider deadline covers the response body", () => {
  it("keeps the abort armed until the body has been read", () => {
    // The gap: clearTimeout used to run in a finally attached to the fetch
    // alone, so a server that sent headers and then stalled the body was
    // unbounded. The body reads must sit INSIDE the guarded block.
    const guarded = OPENAI_SOURCE.slice(
      OPENAI_SOURCE.indexOf("const controller = new AbortController();"),
      OPENAI_SOURCE.indexOf("clearTimeout(timeout);")
    );
    expect(guarded).toContain("await response.json()");
    expect(guarded).toContain("await response.text()");
    expect(guarded).toContain("signal: controller.signal");
  });

  it("still reports an abort as a timeout, naming the budget", () => {
    expect(OPENAI_SOURCE).toContain('error.name === "AbortError"');
    expect(OPENAI_SOURCE).toContain("timed out after ${this.config.timeoutMs}ms");
  });

  it("does not relabel a status or parse failure as a transport failure", () => {
    // Those errors are already shaped and already safe; re-wrapping them would
    // lose the status code the operator needs.
    expect(OPENAI_SOURCE).toContain("if (error instanceof AiVisionError) throw error;");
  });

  it("clears its timer exactly once, in a finally", () => {
    expect(OPENAI_SOURCE.match(/clearTimeout\(timeout\);/g) ?? []).toHaveLength(1);
    expect(OPENAI_SOURCE).toContain("} finally {");
  });

  it("reuses the existing configured budget rather than inventing one", () => {
    // AI_VISION_TIMEOUT_MS already existed; this change did not add a knob.
    expect(OPENAI_SOURCE).toContain("this.config.timeoutMs");
    expect(OPENAI_SOURCE).not.toMatch(/const\s+\w*TIMEOUT_MS\s*=/);
  });
});

// ===========================================================================
// F/G/H/R. Alert state and retry
// ===========================================================================

describe("F/H. a timeout never leaves the alert stuck in a processing state", () => {
  it("writes FAILED with the reason on every attempt, retryable or not", () => {
    // The alert must never sit in PROCESSING_SCREENSHOT or ANALYZING_WITH_AI
    // with no explanation. markFailed persists errorMessage, so the durable
    // record always carries why.
    expect(WORKER_SOURCE).toContain("await alertsService.markFailed(alertId, message);");
    const catchBlock = WORKER_SOURCE.slice(WORKER_SOURCE.indexOf("} catch (error) {"));
    expect(catchBlock).toContain("markFailed");
  });

  it("never marks a timeout ANALYZED", () => {
    const catchBlock = WORKER_SOURCE.slice(
      WORKER_SOURCE.indexOf("} catch (error) {"),
      WORKER_SOURCE.indexOf("throw error; // let BullMQ")
    );
    expect(catchBlock).not.toContain("markAnalyzed");
  });

  it("introduces no new AlertStatus value", () => {
    const schema = readFileSync(path.resolve(__dirname, "../prisma/schema.prisma"), "utf8");
    const statuses = schema
      .slice(schema.indexOf("enum AlertStatus"), schema.indexOf("}", schema.indexOf("enum AlertStatus")))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("enum"));
    expect(statuses).toEqual([
      "RECEIVED",
      "PROCESSING_SCREENSHOT",
      "ANALYZING_WITH_AI",
      "ANALYZED",
      "FAILED",
      "IGNORED_DUPLICATE",
    ]);
  });
});

describe("G/R. retry stays bounded by the existing policy", () => {
  const QUEUE_SOURCE = readFileSync(path.resolve(__dirname, "../src/modules/jobs/queue.ts"), "utf8");

  it("the vision queue's attempts and backoff are unchanged", () => {
    expect(QUEUE_SOURCE).toContain("attempts: 2");
    expect(QUEUE_SOURCE).toContain('backoff: { type: "exponential", delay: 3000 }');
  });

  it("a timeout rethrows, so BullMQ owns the retry decision", () => {
    expect(WORKER_SOURCE).toContain("throw error; // let BullMQ apply its retry/backoff policy");
  });

  it("this change adds no retry loop of its own", () => {
    // A bounded deadline that then retried internally would multiply the very
    // slot occupancy this feature exists to bound: two attempts inside one job
    // would double the time a hung render holds its concurrency slot, on top
    // of the two attempts BullMQ already owns.
    expect(CHART_CODE).not.toMatch(/for\s*\(|while\s*\(|MAX_ATTEMPTS/);
    expect(CHART_CODE).not.toMatch(/\battempt\b/i);
  });

  it("a retry reuses the same alert row, so no duplicate alert can appear", () => {
    // The job carries only an alertId; every step updates that row by id.
    expect(WORKER_SOURCE).toContain("const { alertId } = job.data;");
    const processor = WORKER_SOURCE.slice(
      WORKER_SOURCE.indexOf("async function processVisionAnalysisJob"),
      WORKER_SOURCE.indexOf("async function processExtremeRRJob")
    );
    expect(processor).not.toContain("alert.create");
    expect(processor).not.toContain("createAlert");
  });
});

// ===========================================================================
// L/M. Blast radius
// ===========================================================================

describe("L. timeout handling touches no execution state", () => {
  it("the vision processor never reaches an execution or a Binance call", () => {
    const processor = WORKER_SOURCE.slice(
      WORKER_SOURCE.indexOf("async function processVisionAnalysisJob"),
      WORKER_SOURCE.indexOf("async function processExtremeRRJob")
    );
    for (const forbidden of [
      "tradeExecution",
      "SelectedPlanExecutor",
      "selectedPlanExecutor",
      "admitAndSubmit",
      "binance",
      "protection",
      "naturalWindow",
      "maxClaims",
    ]) {
      expect(`${forbidden}:${processor.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("the renderer reaches nothing beyond Playwright and formatting", () => {
    const imports = [...CHART_SOURCE.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual([
      "@prisma/client",
      "@trading-alert-dashboard/shared",
      "../market-data/market-data.types",
      "node:path",
      "playwright",
    ].sort());
  });
});

describe("M. a job timeout does not involve worker supervision", () => {
  it("the renderer cannot restart, kill or supervise anything", () => {
    for (const forbidden of ["supervision", "restart", "process.exit", "taskkill", "spawn"]) {
      expect(`${forbidden}:${CHART_SOURCE.toLowerCase().includes(forbidden.toLowerCase())}`).toBe(
        `${forbidden}:false`
      );
    }
  });

  it("a timed-out job leaves the worker running, so no restart budget is spent", async () => {
    // The proof is behavioural: the call returns (rejects) and the process
    // carries on to run the next job. Slot recovery does not need the worker
    // to die and come back.
    const hung = fakeBrowser({ hangAt: "evaluate" });
    await expect(
      renderChartScreenshot(input, { ...fast, launch: async () => hung.browser })
    ).rejects.toBeInstanceOf(ChartRenderTimeoutError);

    const next = fakeBrowser();
    await expect(renderChartScreenshot(input, { ...fast, launch: async () => next.browser })).resolves.toBe(
      PNG
    );
  });

  it("worker supervision still keys off attestation, not job outcomes", () => {
    const supervision = codeOf(
      readFileSync(path.resolve(__dirname, "../src/modules/operator/worker-supervision.ts"), "utf8")
    );
    // It has no notion of a queue job at all, so a screenshot timeout cannot
    // reach its restart budget. Matched on whole words: "supervision" itself
    // contains "vision", which a naive substring scan reads as a false hit.
    for (const forbidden of [/\bvisionAnalysis/, /\bscreenshot/i, /\bjob\b/i, /\bbullmq\b/i, /\bQueue\b/]) {
      expect(`${forbidden}:${forbidden.test(supervision)}`).toBe(`${forbidden}:false`);
    }
    // What it DOES key off is unchanged: process ownership plus attestation.
    expect(supervision).toContain("workerHealth");
    expect(supervision).toContain("verifyOwnership");
  });
});

// ===========================================================================
// N. Sanitized diagnostics
// ===========================================================================

describe("N. timeout logging is diagnosable and safe", () => {
  it("logs named fields, never the raw error object", () => {
    // A Playwright failure carries the template's absolute file:// path.
    expect(WORKER_SOURCE).not.toContain('logger.error({ alertId, error }, "Vision analysis job failed")');
    expect(WORKER_SOURCE).toContain("error: message.slice(0, 300),");
  });

  it("records the stage, attempt and elapsed budget", () => {
    for (const field of ["stage,", "attempt,", "totalAttempts,", "elapsedMs:", "jobId: job.id,", "timedOut:"]) {
      expect(WORKER_SOURCE, field).toContain(field);
    }
  });

  it("names every pipeline stage it can report", () => {
    expect(WORKER_SOURCE).toContain(
      'type VisionPipelineStage = "LOAD_ALERT" | "SCREENSHOT" | "AI_ANALYSIS" | "PERSIST_RESULT";'
    );
  });

  it("logs no credential, environment or connection string", () => {
    for (const forbidden of [
      "OPENAI_API_KEY",
      "apiKey",
      "process.env",
      "WEBHOOK_SECRET",
      "DATABASE_URL",
      "Authorization",
    ]) {
      expect(`${forbidden}:${WORKER_SOURCE.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("the timeout error itself carries only a duration", () => {
    const error = new ChartRenderTimeoutError(60_000);
    expect(error.message).toBe("Chart screenshot render exceeded its 60000ms deadline");
    expect(error.name).toBe("ChartRenderTimeoutError");
    expect(error.code).toBe("CHART_RENDER_TIMEOUT");
  });
});

// ===========================================================================
// The shipped constants
// ===========================================================================

describe("the production deadlines are conservative and coherent", () => {
  it("holds the exact shipped values", () => {
    expect(CHART_BROWSER_LAUNCH_TIMEOUT_MS).toBe(30_000);
    expect(CHART_STEP_TIMEOUT_MS).toBe(15_000);
    expect(CHART_RENDER_DEADLINE_MS).toBe(60_000);
    expect(CHART_BROWSER_CLOSE_TIMEOUT_MS).toBe(5_000);
  });

  it("the whole-render deadline exceeds any single step it contains", () => {
    // Otherwise the outer deadline would fire on a healthy-but-slow step and
    // turn a working render into a timeout.
    expect(CHART_RENDER_DEADLINE_MS).toBeGreaterThan(CHART_STEP_TIMEOUT_MS);
    expect(CHART_RENDER_DEADLINE_MS).toBeGreaterThanOrEqual(CHART_BROWSER_LAUNCH_TIMEOUT_MS);
    expect(CHART_BROWSER_CLOSE_TIMEOUT_MS).toBeLessThan(CHART_STEP_TIMEOUT_MS);
  });

  it("keeps a two-attempt alert well inside a few minutes of slot time", () => {
    // attempts: 2, so this is the worst case one alert can occupy a slot for.
    const worstCasePerAttempt = CHART_RENDER_DEADLINE_MS + CHART_BROWSER_CLOSE_TIMEOUT_MS;
    expect(worstCasePerAttempt * 2).toBeLessThanOrEqual(5 * 60_000);
  });

  it("centralizes them — every deadline resolves from a named constant", () => {
    // Each of the four is defaulted from its constant in exactly one place, so
    // there is no second copy to drift. The viewport (1200x630) and the 150ms
    // paint settle are layout, not deadlines, and are deliberately untouched.
    for (const name of [
      "CHART_BROWSER_LAUNCH_TIMEOUT_MS",
      "CHART_STEP_TIMEOUT_MS",
      "CHART_RENDER_DEADLINE_MS",
      "CHART_BROWSER_CLOSE_TIMEOUT_MS",
    ]) {
      expect(CHART_CODE.match(new RegExp(`\\?\\? ${name}`, "g")) ?? [], name).toHaveLength(1);
      expect(CHART_CODE.match(new RegExp(`export const ${name} =`, "g")) ?? [], name).toHaveLength(1);
    }
    // No deadline literal is written inline anywhere in the render path.
    const body = CHART_CODE.slice(CHART_CODE.indexOf("async function renderWithin"));
    for (const literal of ["30_000", "15_000", "60_000", "5_000", "30000", "15000", "60000"]) {
      expect(`${literal}:${body.includes(literal)}`).toBe(`${literal}:false`);
    }
  });
});

// ===========================================================================
// O. The successful flow is untouched
// ===========================================================================

describe("O. the existing successful vision flow is unchanged", () => {
  it("the worker still runs the same pipeline in the same order", () => {
    const processor = WORKER_SOURCE.slice(
      WORKER_SOURCE.indexOf("async function processVisionAnalysisJob"),
      WORKER_SOURCE.indexOf("async function processExtremeRRJob")
    );
    const order = [
      "markProcessingScreenshot",
      "getRecentCandles",
      "generateAndSaveScreenshot",
      "markScreenshotSaved",
      "markAnalyzingWithAi",
      "analyzeChart",
      "markAnalyzed",
      "notifyAnalyzedAlert",
    ];
    let cursor = -1;
    for (const step of order) {
      const at = processor.indexOf(step);
      expect(at, step).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("the renderer still produces the same chart from the same inputs", async () => {
    const fake = fakeBrowser();
    await renderChartScreenshot(input, { ...fast, launch: async () => fake.browser });
    // Same steps, same order as before the change — the deadlines wrap the
    // pipeline, they do not alter it.
    expect(fake.trace).toContain("addScriptTag");
    expect(fake.trace).toContain("waitForFunction");
    expect(fake.trace.indexOf("evaluate")).toBeGreaterThan(fake.trace.indexOf("addScriptTag"));
    expect(fake.trace.indexOf("screenshot")).toBeGreaterThan(fake.trace.indexOf("waitForFunction"));
  });

  it("screenshot.service still owns persistence and the renderer only returns a buffer", () => {
    const screenshotService = readFileSync(
      path.resolve(__dirname, "../src/modules/chart-renderer/screenshot.service.ts"),
      "utf8"
    );
    expect(screenshotService).toContain("await writeFile(filePath, buffer)");
    expect(CHART_SOURCE).not.toContain("writeFile");
  });

  it("provider selection, mock behaviour and fallback are untouched", () => {
    const service = readFileSync(
      path.resolve(__dirname, "../src/modules/ai-vision/ai-vision.service.ts"),
      "utf8"
    );
    expect(service).toContain("AI_VISION_FALLBACK_TO_MOCK");
    expect(service).toContain("MockAiVisionProvider");
    expect(service).toContain('case "openai":');
  });

  it("the prompt and model selection are unchanged", () => {
    expect(OPENAI_SOURCE).toContain("AI_VISION_SYSTEM_PROMPT");
    expect(OPENAI_SOURCE).toContain("buildVisionUserPrompt");
    expect(OPENAI_SOURCE).toContain("model: this.config.model");
    expect(OPENAI_SOURCE).toContain('response_format: { type: "json_object" }');
    expect(OPENAI_SOURCE).toContain("temperature: 0.2");
  });
});
