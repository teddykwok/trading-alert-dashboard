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

export interface RenderChartInput {
  candles: OhlcvCandle[];
  price: number;
  symbol: string;
  timeframe: string;
  signal: SignalType;
}

/**
 * Opens the local chart-template.html in a headless Chromium instance,
 * injects the Lightweight Charts library + candle data, waits for the chart
 * to finish rendering, then screenshots just the chart wrapper element.
 * Returns a PNG buffer; saving it to disk is the caller's responsibility
 * (see screenshot.service.ts).
 */
export async function renderChartScreenshot(input: RenderChartInput): Promise<Buffer> {
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await page.goto(`file://${TEMPLATE_PATH}`);
    await page.addScriptTag({ path: LIGHTWEIGHT_CHARTS_SCRIPT });

    // Decimals scale with the alert price's magnitude so small-cap/perp
    // prices (e.g. 0.004086) don't collapse to "0.00" on the axis, the alert
    // marker, or the overlay label. Candles share the asset's magnitude.
    const priceFormat = pricePrecisionFor(input.price);
    const priceText = formatDynamicPrice(input.price);

    await page.evaluate(
      ({ candles, price, symbol, timeframe, signal, priceFormat, priceText }) => {
        // @ts-expect-error - renderChart is defined in chart-template.html
        window.renderChart({
          candles,
          priceLine: { price },
          priceFormat,
          label: { symbol, timeframe, signal, price: priceText },
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
  } finally {
    await browser.close();
  }
}
