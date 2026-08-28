import path from "node:path";
import { chromium } from "playwright";
import { formatDynamicPrice, pricePrecisionFor } from "@trading-alert-dashboard/shared";
import type { OhlcvCandle } from "../market-data/market-data.types";
import type { SignalType } from "@prisma/client";

const TEMPLATE_PATH = path.join(__dirname, "chart-template.html");

// lightweight-charts' package.json "exports" map only whitelists "." and
// "./package.json", so the standalone browser bundle (needed as a plain
// <script> tag, not an ESM/CJS module) can't be reached via
// require.resolve() directly. Resolve the package root instead (which is
// whitelisted) and join the on-disk path to the bundle from there.
const PACKAGE_ROOT = path.dirname(require.resolve("lightweight-charts/package.json"));
const LIGHTWEIGHT_CHARTS_SCRIPT = path.join(
  PACKAGE_ROOT,
  "dist/lightweight-charts.standalone.production.js"
);

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

/**
 * Why this file has explicit deadlines at all.
 *
 * Playwright bounds MOST of what happens here on its own — `goto`,
 * `addScriptTag`, `waitForFunction` and `screenshot` all default to 30s. Two
 * operations are different, and they are the ones that matter:
 *
 *   page.evaluate()  accepts NO options at all, so it has no timeout and
 *                    `setDefaultTimeout` cannot reach it — that method only
 *                    changes "the default maximum time for all the methods
 *                    accepting a timeout option". A page script that never
 *                    returns hangs this call forever.
 *   browser.close()  likewise takes no deadline, so a wedged browser can hang
 *                    the very `finally` that was supposed to clean up.
 *
 * That matters more than it looks. The vision worker runs `concurrency: 2`,
 * and BullMQ will NOT reclaim the slot: its lock manager renews a running
 * job's lock on a timer that is independent of whether the processor promise
 * ever settles, so a hung-but-alive job keeps its lock renewed and is never
 * treated as stalled. Two hung renders would therefore occupy both slots
 * permanently and the alert pipeline would stop — silently, with the worker
 * process still healthy and still attesting.
 *
 * The values below are deliberately generous. Everything this renderer loads
 * is LOCAL — a file:// template and an on-disk bundle — so a normal render is
 * well under a second. These are ceilings that catch a hang, not budgets a
 * healthy render should ever approach.
 */

/** Cold Chromium start. Playwright's own default, stated explicitly. */
export const CHART_BROWSER_LAUNCH_TIMEOUT_MS = 30_000;

/**
 * Per-step ceiling for every Playwright call that accepts one, applied through
 * `page.setDefaultTimeout`. Half Playwright's implicit default: nothing here
 * touches the network, so 15s is already ~50x a slow local render.
 */
export const CHART_STEP_TIMEOUT_MS = 15_000;

/**
 * The whole-render ceiling, and the only thing that can bound `page.evaluate`.
 * Comfortably above the sum of a slow-but-healthy path (launch + navigate +
 * inject + render + screenshot), so it fires on a hang rather than on load.
 */
export const CHART_RENDER_DEADLINE_MS = 60_000;

/**
 * How long disposal may take before we stop waiting for it. Closing a healthy
 * Chromium is sub-second; refusing to wait longer is what keeps the `finally`
 * from becoming the hang it exists to prevent.
 */
export const CHART_BROWSER_CLOSE_TIMEOUT_MS = 5_000;

/** Raised when a render exceeds its deadline. Carries no path and no URL. */
export class ChartRenderTimeoutError extends Error {
  readonly code = "CHART_RENDER_TIMEOUT";
  constructor(readonly timeoutMs: number) {
    super(`Chart screenshot render exceeded its ${timeoutMs}ms deadline`);
    this.name = "ChartRenderTimeoutError";
  }
}

export interface RenderChartInput {
  candles: OhlcvCandle[];
  price: number;
  symbol: string;
  timeframe: string;
  signal: SignalType;
}

// ---------------------------------------------------------------------------
// The minimum Playwright surface this module uses
// ---------------------------------------------------------------------------

/**
 * Structural types covering exactly the calls made below.
 *
 * Not an abstraction layer — a test seam. The real `chromium.launch` satisfies
 * these, and a fake can too, which is what makes "a hung evaluate is bounded
 * and its browser is closed" provable without launching a real browser or
 * waiting a real minute.
 */
export interface ChartPage {
  setDefaultTimeout(timeout: number): void;
  goto(url: string): Promise<unknown>;
  addScriptTag(options: { path: string }): Promise<unknown>;
  evaluate<Arg>(pageFunction: (arg: Arg) => void, arg: Arg): Promise<unknown>;
  waitForFunction(pageFunction: () => boolean): Promise<unknown>;
  waitForTimeout(timeout: number): Promise<void>;
  locator(selector: string): { screenshot(): Promise<Buffer> };
}

export interface ChartBrowser {
  newPage(options: { viewport: { width: number; height: number } }): Promise<ChartPage>;
  close(): Promise<void>;
}

export interface RenderChartOptions {
  launchTimeoutMs?: number;
  stepTimeoutMs?: number;
  renderDeadlineMs?: number;
  closeTimeoutMs?: number;
  /** Injected in tests; defaults to a real headless Chromium. */
  launch?: (options: { timeout: number }) => Promise<ChartBrowser>;
  /** Injected in tests so a timeout can be proven without waiting for one. */
  onTimeout?: (detail: { stage: "RENDER" | "CLOSE"; timeoutMs: number }) => void;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Rejects after `ms`, and always clears its own timer. */
function deadline(ms: number, makeError: () => Error): { promise: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
    // A deadline must never hold the process open by itself.
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Closes the browser without ever hanging on it.
 *
 * A close that does not return within its ceiling is reported and abandoned.
 * That leaks at most one Chromium process per concurrent job — bounded, and
 * strictly better than the alternative, which is a permanently occupied worker
 * slot. Playwright also terminates its browsers when the owning Node process
 * exits, so the leak cannot outlive the worker.
 */
async function closeBrowserBounded(
  browser: ChartBrowser,
  timeoutMs: number,
  onTimeout?: RenderChartOptions["onTimeout"]
): Promise<void> {
  const guard = deadline(timeoutMs, () => new ChartRenderTimeoutError(timeoutMs));
  try {
    await Promise.race([browser.close(), guard.promise]);
  } catch {
    onTimeout?.({ stage: "CLOSE", timeoutMs });
  } finally {
    guard.cancel();
  }
}

/** The render itself. Every step here accepts a timeout except `evaluate`. */
async function renderWithin(
  browser: ChartBrowser,
  input: RenderChartInput,
  stepTimeoutMs: number
): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  // One explicit ceiling for goto, addScriptTag, waitForFunction and
  // screenshot, instead of four inherited implicit ones.
  page.setDefaultTimeout(stepTimeoutMs);

  await page.goto(`file://${TEMPLATE_PATH}`);
  await page.addScriptTag({ path: LIGHTWEIGHT_CHARTS_SCRIPT });

  // Decimals scale with the alert price's magnitude so small-cap/perp
  // prices (e.g. 0.004086) don't collapse to "0.00" on the axis, the alert
  // marker, or the overlay label. Candles share the asset's magnitude.
  const priceFormat = pricePrecisionFor(input.price);
  const priceText = formatDynamicPrice(input.price);

  await page.evaluate(
    ({ candles, price, symbol, timeframe, signal, priceFormat: format, priceText: text }) => {
      // @ts-expect-error - renderChart is defined in chart-template.html
      window.renderChart({
        candles,
        priceLine: { price },
        priceFormat: format,
        label: { symbol, timeframe, signal, price: text },
      });
    },
    {
      candles: input.candles,
      price: input.price,
      symbol: input.symbol,
      timeframe: input.timeframe,
      signal: input.signal,
      priceFormat,
      priceText,
    }
  );

  await page.waitForFunction(() => (window as unknown as { __CHART_READY__?: boolean }).__CHART_READY__ === true);
  await page.waitForTimeout(150); // let the final paint settle

  const wrapper = page.locator("#chart-wrapper");
  return await wrapper.screenshot();
}

/**
 * Opens the local chart-template.html in a headless Chromium instance,
 * injects the Lightweight Charts library + candle data, waits for the chart
 * to finish rendering, then screenshots just the chart wrapper element.
 * Returns a PNG buffer; saving it to disk is the caller's responsibility
 * (see screenshot.service.ts).
 *
 * ## Why racing a deadline is safe HERE
 *
 * Racing a promise normally leaves the losing operation running invisibly,
 * which is worse than the hang it replaced. This case is different for one
 * specific reason: the browser is launched INSIDE this function and is owned
 * by nothing else, so the `finally` can dispose of it unconditionally. Closing
 * it terminates the Chromium process, and terminating that process is what
 * actually aborts a hung `page.evaluate` — the race reports the timeout, the
 * disposal makes it true.
 *
 * The corollary matters just as much: because each call owns its own browser,
 * one job's timeout cannot touch a concurrently rendering job's browser, page
 * or screenshot.
 */
export async function renderChartScreenshot(
  input: RenderChartInput,
  options: RenderChartOptions = {}
): Promise<Buffer> {
  const launchTimeoutMs = options.launchTimeoutMs ?? CHART_BROWSER_LAUNCH_TIMEOUT_MS;
  const stepTimeoutMs = options.stepTimeoutMs ?? CHART_STEP_TIMEOUT_MS;
  const renderDeadlineMs = options.renderDeadlineMs ?? CHART_RENDER_DEADLINE_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? CHART_BROWSER_CLOSE_TIMEOUT_MS;
  const launch =
    options.launch ?? ((launchOptions) => chromium.launch(launchOptions) as unknown as Promise<ChartBrowser>);

  const browser = await launch({ timeout: launchTimeoutMs });
  const guard = deadline(renderDeadlineMs, () => new ChartRenderTimeoutError(renderDeadlineMs));

  try {
    return await Promise.race([renderWithin(browser, input, stepTimeoutMs), guard.promise]);
  } catch (error) {
    if (error instanceof ChartRenderTimeoutError) {
      options.onTimeout?.({ stage: "RENDER", timeoutMs: renderDeadlineMs });
    }
    throw error;
  } finally {
    guard.cancel();
    // Unconditional: the browser belongs to this call and to nothing else, so
    // there is no case in which leaving it open is correct.
    await closeBrowserBounded(browser, closeTimeoutMs, options.onTimeout);
  }
}
