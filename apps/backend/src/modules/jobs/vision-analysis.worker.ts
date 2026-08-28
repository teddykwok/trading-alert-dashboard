import path from "node:path";
import { Worker, type Job } from "bullmq";
import { EXTREME_RR_QUEUE_NAME, VISION_ANALYSIS_QUEUE_NAME } from "@trading-alert-dashboard/shared";
import { logger } from "../../config/logger";
import { prisma } from "../../plugins/prisma";
import { AlertsService } from "../alerts/alerts.service";
import { getRecentCandles } from "../market-data/market-data.service";
import { generateAndSaveScreenshot } from "../chart-renderer/screenshot.service";
import { ChartRenderTimeoutError } from "../chart-renderer/chart-renderer.service";
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
import { createRuntimeAttestationPublisher } from "../runtime/runtime-attestation";
import {
  createAttestationRedisClient,
  describeRedisFailure,
} from "../runtime/attestation-redis";
import { startExecutionNotificationScheduler } from "./execution-notification.scheduler";
import {
  createExecutionOrchestrator,
  isReconciliationHealthy,
  startExecutionOrchestrationScheduler,
} from "./execution-orchestration.scheduler";
import { BinanceMarginPlanService } from "../binance/binance-margin-plan.service";
import { ExecutionService } from "../execution/execution.service";
import { SelectedPlanExecutor } from "../execution/selected-plan-executor";

const alertsService = new AlertsService(prisma);

/** Where a vision job was when it failed. Diagnostic only, never persisted. */
type VisionPipelineStage = "LOAD_ALERT" | "SCREENSHOT" | "AI_ANALYSIS" | "PERSIST_RESULT";

/**
 * Runs the full screenshot -> AI vision pipeline for one alert. This is
 * deliberately the only place that touches screenshot generation and AI
 * analysis, keeping the webhook request path fast (see webhook.service.ts).
 */
async function processVisionAnalysisJob(job: Job<VisionAnalysisJobData>): Promise<void> {
  const { alertId } = job.data;
  // Which step was in flight when it failed. The alert's own status cannot
  // answer that: a render deadline and an AI deadline both leave it
  // PROCESSING_SCREENSHOT or ANALYZING_WITH_AI, and a hang has no stack worth
  // reading. Purely diagnostic - it is never persisted as state.
  let stage: VisionPipelineStage = "LOAD_ALERT";
  const startedAtMs = Date.now();

  try {
    let alert = await alertsService.getByIdOrThrow(alertId);

    stage = "SCREENSHOT";
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

    stage = "AI_ANALYSIS";
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

    stage = "PERSIST_RESULT";
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
    const totalAttempts = job.opts.attempts ?? 1;
    const attempt = job.attemptsMade + 1;

    // Named fields, never the raw error object. A Playwright failure carries
    // the template's absolute file:// path, and the whole point of a log an
    // operator will paste into an issue is that it holds nothing they would
    // then have to redact. The provider already guarantees its own messages
    // never contain the API key.
    logger.error(
      {
        alertId,
        jobId: job.id,
        stage,
        attempt,
        totalAttempts,
        elapsedMs: Date.now() - startedAtMs,
        timedOut: error instanceof ChartRenderTimeoutError,
        error: message.slice(0, 300),
      },
      "Vision analysis job failed"
    );

    // FAILED is written on EVERY attempt, including retryable ones, so the
    // alert can never sit in PROCESSING_SCREENSHOT or ANALYZING_WITH_AI with
    // no explanation. A later successful retry overwrites it with ANALYZED;
    // if attempts run out, this is already the terminal record and it carries
    // the reason in errorMessage.
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

// Phase 12.4D-A.1: published only after the worker has reached its ready point,
// carrying the execution gates THIS process loaded. An activation command
// refuses unless this agrees with the backend and with the command's own
// snapshot, which is what makes a stale-.env worker impossible to arm over.
// The heartbeat runs on its OWN bounded connection, never the BullMQ one:
// BullMQ requires maxRetriesPerRequest=null, which is precisely the option
// that lets a command wait forever instead of failing. See attestation-redis.
const attestationRedis = createAttestationRedisClient({
  onError: (detail) => logger.error({ detail }, "Runtime attestation Redis connection error"),
});

const runtimeAttestation = createRuntimeAttestationPublisher({
  role: "WORKER",
  redis: attestationRedis.redis,
  // A worker whose reconciliation has stalled stops attesting, so the
  // existing fail-closed interlock refuses to arm over it. This gates NEW
  // activation only — protection and reconciliation of executions already
  // admitted never consult attestation.
  healthy: isReconciliationHealthy,
  onWithdraw: () =>
    logger.error(
      {},
      "Runtime attestation WITHDRAWN — this worker is no longer fit to be counted as a live " +
        "runtime, so new live activation is blocked. Controlled worker recovery is required; " +
        "do NOT start another runtime stack while the launcher-owned runtime is still active."
    ),
  onError: (error) =>
    logger.error({ detail: describeRedisFailure(error) }, "Runtime attestation heartbeat failed"),
});
runtimeAttestation.start();

process.on("SIGTERM", async () => {
  // Best effort; a crash relies on TTL expiry instead.
  await runtimeAttestation.stop();
  await attestationRedis.close();
  clearInterval(cleanupTimer);
  clearInterval(notificationTimer);
  clearInterval(orchestrationTimer);
  await worker.close();
  await extremeRRWorker.close();
  await retentionWorker?.close();
  await prisma.$disconnect();
  process.exit(0);
});
