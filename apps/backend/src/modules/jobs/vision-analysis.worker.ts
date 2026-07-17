import path from "node:path";
import { Worker, type Job } from "bullmq";
import { VISION_ANALYSIS_QUEUE_NAME } from "@trading-alert-dashboard/shared";
import { logger } from "../../config/logger";
import { prisma } from "../../plugins/prisma";
import { AlertsService } from "../alerts/alerts.service";
import { getRecentCandles } from "../market-data/market-data.service";
import { generateAndSaveScreenshot } from "../chart-renderer/screenshot.service";
import { analyzeChart } from "../ai-vision/ai-vision.service";
import {
  notifyAlertFailed,
  notifyAlertUpdated,
  notifyAnalyzedAlert,
} from "../notifications/notification.service";
import { ensureScreenshotDir, screenshotFileName } from "../../utils/file";
import { inferMarketType } from "../../utils/symbol";
import { bullConnection, type VisionAnalysisJobData } from "./queue";
import { startCleanupScheduler } from "./cleanup.worker";
import { setupRetentionSchedule } from "./retention.worker";

const alertsService = new AlertsService(prisma);

/**
 * Runs the full screenshot -> AI vision pipeline for one alert. This is
 * deliberately the only place that touches screenshot generation and AI
 * analysis, keeping the webhook request path fast (see webhook.service.ts).
 */
async function processVisionAnalysisJob(job: Job<VisionAnalysisJobData>): Promise<void> {
  const { alertId } = job.data;

  try {
    let alert = await alertsService.getByIdOrThrow(alertId);

    alert = await alertsService.markProcessingScreenshot(alertId);
    await notifyAlertUpdated(alert);

    // Alert.symbol is stored normalized (no ".P"), so the spot-vs-futures
    // distinction is re-derived from the original TradingView symbol kept in
    // rawPayload. Falls back to alert.symbol (-> "spot") if absent.
    const rawPayloadSymbol = (alert.rawPayload as { symbol?: unknown } | null)?.symbol;
    const marketType = inferMarketType(rawPayloadSymbol ?? alert.symbol);

    const candles = await getRecentCandles(
      alert.assetType,
      alert.symbol,
      alert.timeframe,
      alert.price,
      alert.exchange,
      marketType
    );

    const screenshotUrl = await generateAndSaveScreenshot(alertId, {
      candles,
      price: alert.price,
      symbol: alert.symbol,
      timeframe: alert.timeframe,
      signal: alert.signal,
    });

    await alertsService.markScreenshotSaved(alertId, screenshotUrl);
    alert = await alertsService.markAnalyzingWithAi(alertId);
    await notifyAlertUpdated(alert);

    const screenshotDir = await ensureScreenshotDir();
    const screenshotAbsolutePath = path.join(screenshotDir, screenshotFileName(alertId));

    const aiResult = await analyzeChart({
      screenshotPath: screenshotAbsolutePath,
      context: {
        symbol: alert.symbol,
        timeframe: alert.timeframe,
        signal: alert.signal,
        price: alert.price,
        indicatorName: alert.indicatorName,
        indicatorValue: alert.indicatorValue,
      },
    });

    alert = await alertsService.markAnalyzed(alertId, {
      aiBias: aiResult.bias,
      aiConfidence: aiResult.confidence,
      aiPattern: aiResult.pattern,
      aiSummary: aiResult.summary,
      aiRiskNotes: aiResult.riskNotes,
      aiProvider: aiResult.provider,
    });
    await notifyAlertUpdated(alert);

    // Best-effort Telegram notification. Wrapped so a notification failure can
    // never fail the alert or the BullMQ job — the alert is already ANALYZED.
    try {
      await notifyAnalyzedAlert(alert);
    } catch (notifyError) {
      logger.warn({ alertId, error: notifyError }, "Telegram notification failed (non-fatal)");
    }

    logger.info({ alertId }, "Vision analysis job completed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error during vision analysis";
    logger.error({ alertId, error }, "Vision analysis job failed");

    const failedAlert = await alertsService.markFailed(alertId, message);
    await notifyAlertFailed(failedAlert);

    throw error; // let BullMQ apply its retry/backoff policy
  }
}

const worker = new Worker<VisionAnalysisJobData>(VISION_ANALYSIS_QUEUE_NAME, processVisionAnalysisJob, {
  connection: bullConnection,
  concurrency: 2,
});

worker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "Job completed");
});

worker.on("failed", (job, error) => {
  logger.error({ jobId: job?.id, error }, "Job failed permanently");
});

const cleanupTimer = startCleanupScheduler();

// Daily bounded-data-retention cleanup (03:00 Asia/Singapore by default).
// Failure to schedule must never take down the vision worker.
let retentionWorker: Awaited<ReturnType<typeof setupRetentionSchedule>> = null;
setupRetentionSchedule()
  .then((created) => {
    retentionWorker = created;
  })
  .catch((error) => {
    logger.error({ error }, "Failed to set up data-retention schedule (worker continues)");
  });

logger.info("vision-analysis worker started, waiting for jobs...");

process.on("SIGTERM", async () => {
  clearInterval(cleanupTimer);
  await worker.close();
  await retentionWorker?.close();
  await prisma.$disconnect();
  process.exit(0);
});
