import path from "node:path";
import { writeFile } from "node:fs/promises";
import { renderChartScreenshot, type RenderChartInput } from "./chart-renderer.service";
import { ensureScreenshotDir, screenshotFileName } from "../../utils/file";

/**
 * Renders and persists a chart screenshot for an alert, returning a public
 * URL path (served statically by the backend at /screenshots/*).
 */
export async function generateAndSaveScreenshot(
  alertId: string,
  chartInput: RenderChartInput
): Promise<string> {
  const dir = await ensureScreenshotDir();
  const fileName = screenshotFileName(alertId);
  const filePath = path.join(dir, fileName);

  const buffer = await renderChartScreenshot(chartInput);
  await writeFile(filePath, buffer);

  return `/screenshots/${fileName}`;
}
