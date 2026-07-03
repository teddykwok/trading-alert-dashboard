import { mkdir } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";

/**
 * Resolves the configured screenshot storage directory to an absolute path
 * (relative to the backend package root) and ensures it exists.
 */
export async function ensureScreenshotDir(): Promise<string> {
  const dir = path.isAbsolute(env.SCREENSHOT_STORAGE_DIR)
    ? env.SCREENSHOT_STORAGE_DIR
    : path.join(process.cwd(), env.SCREENSHOT_STORAGE_DIR);

  await mkdir(dir, { recursive: true });
  return dir;
}

export function screenshotFileName(alertId: string): string {
  return `${alertId}.png`;
}
