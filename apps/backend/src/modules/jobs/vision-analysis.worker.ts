import path from "node:path";
import { Worker, type Job } from "bullmq";
import { EXTREME_RR_QUEUE_NAME, VISION_ANALYSIS_QUEUE_NAME } from "@trading-alert-dashboard/shared";
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
  notifyExtremeRRPlanOutcome,
} from "../notifications/notification.service";
import { ensureScreenshotDir, screenshotFileName } from "../../utils/file";
import { inferMarketType } from "../../utils/symbol";
import { ExtremeRRService } from "../extreme-rr/extreme-rr.service";
import { bullConnection, type ExtremeRRJobData, type VisionAnalysisJobData } from "./queue";
import { startCleanupScheduler } from "./cleanup.worker";
import { setupRetentionSchedule } from "./retention.worker";
import { startExecutionNotificationScheduler } from "./execution-notification.scheduler";
import {
  createExecutionOrchestrator,
  startExecutionOrchestrationScheduler,
} from "./execution-orchestration.scheduler";
import { BinanceMarginPlanService } from "../binance/binance-margin-plan.service";
import { ExecutionService } from "../execution/execution.service";
import { SelectedPlanExecutor } from "../execution/selected-plan-executor";

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

/**
 * Extreme RR plan generation + the ONE Telegram notification for its final
 * outcome. Runs in this same worker process (one worker architecture, two
 * queues). Unlike the vision pipeline, a plan failure never touches the
 * alert: the service records status ERROR on the PLAN and returns; we then
 * throw so BullMQ retries — a later success simply overwrites the ERROR row
 * (same frozen triggeredAt cutoff, immutable data).
 *
 * Notification rules:
 * - READY: send the concise trade-plan message. A Telegram failure throws so
 *   BullMQ retries the job — regeneration short-circuits on READY, so the
 *   retry only re-attempts the (idempotent, claim-guarded) send.
 * - INVALID: send the concise fallback once, best-effort.
 * - ERROR: only after the FINAL attempt (never for transient failures that
 *   still have retries left), best-effort — then rethrow for BullMQ.
 */
async function processExtremeRRJob(job: Job<ExtremeRRJobData>): Promise<void> {
  const { alertId } = job.data;
  const plan = await extremeRRService.generateForAlert(alertId);

  if (plan.status === "ERROR") {
    const totalAttempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= totalAttempts;
    if (isFinalAttempt) {
      const alert = await alertsService.getByIdOrThrow(alertId);
      await notifyExtremeRRPlanOutcome(prisma, plan, alert);
    }
    throw new Error(plan.errorReason ?? "Extreme RR plan generation failed");
  }

  const alert = await alertsService.getByIdOrThrow(alertId);
  await notifyExtremeRRPlanOutcome(prisma, plan, alert);

  logger.info({ alertId, status: plan.status }, "Extreme RR plan generated");

  // Phase 11A.1: the selected plan becomes a PLAN_READY TradeExecution and is
  // handed to safety admission. Idempotent through the unique
  // (alertId, executionProfileId) constraint, so a redelivered job adopts the
  // existing row instead of creating a second one. Wrapped so an execution
  // problem can never fail the plan job — the persisted PLAN_READY row is
  // recovered by the reconciliation scheduler regardless.
  try {
    const outcome = await selectedPlanExecutor.handleSelectedPlan(plan, alert.symbol);
    logger.info({ alertId, outcome: outcome.handled ? outcome.reasonCode : outcome.reasonCode }, "Selected plan execution handling completed");
  } catch (executionError) {
    logger.error({ alertId, error: executionError }, "Selected plan execution handling failed (non-fatal)");
  }
}

const extremeRRService = new ExtremeRRService(prisma);

// Phase 11A.1 production signal -> execution link.
const selectedPlanExecutor = new SelectedPlanExecutor({
  prisma,
  marginPlanner: new BinanceMarginPlanService(),
  executions: new ExecutionService(prisma),
  orchestrator: createExecutionOrchestrator(),
});

const worker = new Worker<VisionAnalysisJobData>(VISION_ANALYSIS_QUEUE_NAME, processVisionAnalysisJob, {
  connection: bullConnection,
  concurrency: 2,
});

const extremeRRWorker = new Worker<ExtremeRRJobData>(EXTREME_RR_QUEUE_NAME, processExtremeRRJob, {
  connection: bullConnection,
  concurrency: 2,
});

extremeRRWorker.on("failed", (job, error) => {
  logger.error({ jobId: job?.id, error }, "Extreme RR plan job failed");
});

worker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "Job completed");
});

worker.on("failed", (job, error) => {
  logger.error({ jobId: job?.id, error }, "Job failed permanently");
});

const cleanupTimer = startCleanupScheduler();

// Phase 9: the production invocation path for execution Telegram notifications.
// Bounded, read-only with respect to the trading lifecycle, and self-contained —
// a Telegram outage cannot affect any job this worker runs.
const notificationTimer = startExecutionNotificationScheduler();

// Phase 11A.1: startup execution recovery, then bounded periodic reconciliation.
// Every mutation still travels through the Phase 6/7 gates, so with the live
// gates closed this registers work that dispatches nothing.
const orchestrationTimer = startExecutionOrchestrationScheduler();

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
  clearInterval(notificationTimer);
  clearInterval(orchestrationTimer);
  await worker.close();
  await extremeRRWorker.close();
  await retentionWorker?.close();
  await prisma.$disconnect();
  process.exit(0);
});
