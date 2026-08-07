import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { logger } from "../../config/logger";
import { sanitizeMetadata } from "../execution/execution-safety";
import {
  deriveEarnedMilestones,
  deriveMilestoneFromVerification,
  deriveMilestonesFromEvent,
  type DerivedMilestone,
  type ExecutionContext,
  type ExecutionNotificationSnapshot,
  type LifecycleEventRecord,
  type NotificationPayload,
} from "./execution-notification";
import {
  formatCriticalNotification,
  formatExecutionNotification,
  safeText,
  type CriticalNotificationInput,
} from "./execution-notification-format";
import {
  resolveCriticalChatId,
  resolveExecutionChatId,
  sendExecutionTelegramMessage,
  telegramDeliveryEnabled,
  type ExecutionTelegramSender,
  type TelegramDeliveryCode,
} from "./telegram.service";

/**
 * Phase 9 — durable execution notification outbox.
 *
 * OBSERVABILITY ONLY. This service reads persisted execution state and writes
 * notification rows; it never creates, updates or deletes a TradeExecution,
 * never transitions a status, never submits or cancels an order, and imports no
 * Binance client of any kind. Telegram can fail for a week without a single
 * trading decision changing — the worst outcome is an undelivered row that
 * stays visible and retryable.
 *
 * Two stages, deliberately separated:
 *
 *   materializeExecutionNotifications()  persisted state -> notification intents
 *   dispatchPendingNotifications()       intents -> Telegram
 *
 * The split is what keeps a Telegram outage out of the lifecycle: no HTTP call
 * ever happens inside a transaction, and no transaction is ever held open
 * across one.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Bounded work per invocation — this is not a daemon and never loops forever. */
export const DEFAULT_DISPATCH_BATCH_SIZE = 20;

/**
 * A claim older than this is assumed to belong to a crashed process and may be
 * taken over. Long enough that a slow Telegram call is never stolen mid-flight.
 */
export const CLAIM_LEASE_MS = 60_000;

/**
 * Attempts after which a repeatedly failing row stops being retried by the
 * normal sweep. The row is NOT deleted — it stays durable and visible — but a
 * broken chat cannot burn the whole batch budget forever.
 */
export const MAX_RETRYABLE_ATTEMPTS = 8;

/** How many durable history rows one discovery pass may claim. */
export const DEFAULT_DISCOVERY_BATCH_SIZE = 50;

export interface NotificationDestinations {
  /** Normal milestones: the optional execution chat, else the existing chat. */
  execution: string | null;
  /** Critical alerts: the existing critical destination, never duplicated. */
  critical: string | null;
  /**
   * The Telegram master switch. When false the runner still MATERIALIZES
   * durable intents — history must not be lost while notifications are off —
   * but performs zero HTTP dispatch and, critically, never claims a row. Not
   * claiming is what stops every scheduler tick from burning an attempt against
   * the bounded retry budget, so switching Telegram back on later finds every
   * intent still pending with attemptCount 0.
   */
  deliveryEnabled: boolean;
}

export interface DispatchOptions {
  batchSize?: number;
  now?: Date;
}

export interface DispatchSummary {
  criticalDelivered: number;
  criticalFailed: number;
  notificationsDelivered: number;
  notificationsFailed: number;
  skipped: number;
}

export interface MaterializeInput {
  executionId: string;
  evaluatedAt: Date;
}

export interface TickOptions {
  discoveryBatchSize?: number;
  dispatchBatchSize?: number;
}

export interface TickSummary {
  eventsProcessed: number;
  verificationsProcessed: number;
  notificationsCreated: number;
  delivery: DispatchSummary;
  /** True when the tick caught an error. It never rethrows. */
  failed: boolean;
}

export interface MaterializeSummary {
  created: number;
  alreadyPresent: number;
  /** Milestones the persisted state currently earns, new or not. */
  earned: number;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Payload sanitization at the persistence boundary.
 *
 * `sanitizeMetadata` redacts credential-like VALUES but keeps the key name, so
 * a stored payload could still advertise "apiKey". Here the key is dropped
 * outright: nothing downstream should ever see that a credential field existed.
 * Applied even though the payload is assembled internally — an already-clean
 * upstream object is not something to trust blindly.
 */
const FORBIDDEN_PAYLOAD_KEYS = [
  "apikey",
  "apisecret",
  "secret",
  "signature",
  "authorization",
  "token",
  "password",
  "credential",
  "chatid",
  "balance",
  "wallet",
  "accountidentifier",
  "raw",
];

function isForbiddenPayloadKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
  return FORBIDDEN_PAYLOAD_KEYS.some((forbidden) => normalized.includes(forbidden));
}

export function sanitizeNotificationPayload(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limited]";
  if (value === null || typeof value !== "object") return sanitizeMetadata(value, depth);
  if (Array.isArray(value)) return value.map((entry) => sanitizeNotificationPayload(entry, depth + 1));

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenPayloadKey(key)) continue;
    output[key] = sanitizeNotificationPayload(entry, depth + 1);
  }
  return output;
}

// ---------------------------------------------------------------------------
// Unified pending item
// ---------------------------------------------------------------------------

type PendingKind = "CRITICAL" | "NOTIFICATION";

interface PendingItem {
  kind: PendingKind;
  id: string;
  reference: string;
  attempts: number;
}

export class ExecutionNotificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sender: ExecutionTelegramSender,
    private readonly destinations: NotificationDestinations
  ) {}

  // -------------------------------------------------------------------------
  // Materialization
  // -------------------------------------------------------------------------

  /**
   * Derives every milestone the persisted state currently earns and creates the
   * missing intents. Safe to call repeatedly and concurrently: a duplicate is
   * rejected by the unique dedupeKey index, not by an in-memory guard.
   *
   * Never mutates the execution, never queries Binance, never sends anything.
   */
  async materializeExecutionNotifications(input: MaterializeInput): Promise<MaterializeSummary> {
    const snapshot = await this.readSnapshot(input.executionId);
    if (!snapshot) return { created: 0, alreadyPresent: 0, earned: 0 };

    const milestones = deriveEarnedMilestones(snapshot);
    let created = 0;
    let alreadyPresent = 0;

    for (const milestone of milestones) {
      const payload = sanitizeNotificationPayload(milestone.payload) as Prisma.InputJsonValue;
      try {
        await this.prisma.executionNotification.create({
          data: {
            tradeExecutionId: snapshot.executionId,
            notificationType: milestone.type,
            dedupeKey: milestone.dedupeKey,
            severity: milestone.severity,
            milestoneSequence: milestone.milestoneSequence,
            payloadSnapshot: payload,
          },
        });
        created += 1;
      } catch (error) {
        // A concurrent materializer won the unique race — its row stands.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          alreadyPresent += 1;
          continue;
        }
        throw error;
      }
    }

    return { created, alreadyPresent, earned: milestones.length };
  }

  /**
   * Reads the authoritative persisted state. The ENTRY order is generation 1
   * (the original entry); protection trigger prices come from the active
   * protection orders of the current generation.
   */
  private async readSnapshot(executionId: string): Promise<ExecutionNotificationSnapshot | null> {
    const execution = await this.prisma.tradeExecution.findUnique({
      where: { id: executionId },
      include: {
        orders: { orderBy: [{ role: "asc" }, { generation: "desc" }] },
        protectionState: true,
      },
    });
    if (!execution) return null;

    const entryOrder = execution.orders.find((order) => order.role === "ENTRY" && order.generation === 1) ?? null;
    const protection = execution.protectionState;

    const activeProtectionOrder = (role: "STOP_LOSS" | "TAKE_PROFIT"): string | null => {
      if (!protection) return null;
      const order = execution.orders.find(
        (candidate) => candidate.role === role && candidate.generation === protection.currentGeneration
      );
      return order?.triggerPrice?.toFixed() ?? null;
    };

    return {
      executionId: execution.id,
      status: execution.status,
      symbol: execution.symbol,
      direction: execution.direction,
      plannedEntryPrice: execution.plannedEntryPrice.toFixed(),
      plannedQuantity: execution.plannedQuantity.toFixed(),
      selectedLeverage: execution.selectedLeverage,
      riskBudgetUsd: execution.riskBudgetUsd.toFixed(),
      executableStopLoss: execution.executableStopLoss.toFixed(),
      takeProfit: execution.takeProfit?.toFixed() ?? null,
      averageFillPrice: execution.averageFillPrice?.toFixed() ?? null,
      actualExitPrice: execution.actualExitPrice?.toFixed() ?? null,
      realizedPnl: execution.realizedPnl?.toFixed() ?? null,
      tradingFeesUsd: execution.tradingFeesUsd?.toFixed() ?? null,
      fundingPnlUsd: execution.fundingPnlUsd?.toFixed() ?? null,
      exitReason: execution.exitReason,
      decisionReasonCode: execution.decisionReasonCode,
      sanitizedMessage: execution.sanitizedMessage,
      entryOrder: entryOrder
        ? {
            status: entryOrder.status,
            executedQuantity: entryOrder.executedQuantity.toFixed(),
            averageFillPrice: entryOrder.averageFillPrice?.toFixed() ?? null,
            reconciled: entryOrder.lastReconcileAt !== null,
          }
        : null,
      protection: protection
        ? {
            state: protection.state,
            confirmedOpenQuantity: protection.confirmedOpenQuantity.toFixed(),
            protectedStopQuantity: protection.protectedStopQuantity.toFixed(),
            protectedTakeProfitQuantity: protection.protectedTakeProfitQuantity.toFixed(),
            liquidationSafe: protection.liquidationSafe,
            stopTriggerPrice: activeProtectionOrder("STOP_LOSS"),
            takeProfitTriggerPrice: activeProtectionOrder("TAKE_PROFIT"),
          }
        : null,
    };
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  /**
   * Delivers one bounded batch. CRITICAL ALERTS GO FIRST and are counted
   * separately from the informational budget, so an informational flood can
   * never starve a protection failure.
   *
   * Never throws: a delivery problem is recorded on the row and the sweep moves
   * on. Nothing here can affect an execution.
   */
  async dispatchPendingNotifications(options: DispatchOptions = {}): Promise<DispatchSummary> {
    const batchSize = options.batchSize ?? DEFAULT_DISPATCH_BATCH_SIZE;
    const now = options.now ?? new Date();
    const summary: DispatchSummary = {
      criticalDelivered: 0,
      criticalFailed: 0,
      notificationsDelivered: 0,
      notificationsFailed: 0,
      skipped: 0,
    };

    // Telegram is switched off: return before claiming anything. Nothing is
    // sent, no attempt is consumed and every intent stays exactly as it was.
    if (!this.destinations.deliveryEnabled) return summary;

    for (const item of await this.claimCriticalAlerts(batchSize, now)) {
      const result = await this.deliverCritical(item, now);
      if (result === "DELIVERED") summary.criticalDelivered += 1;
      else if (result === "SKIPPED") summary.skipped += 1;
      else summary.criticalFailed += 1;
    }

    for (const item of await this.claimNotifications(batchSize, now)) {
      const result = await this.deliverNotification(item, now);
      if (result === "DELIVERED") summary.notificationsDelivered += 1;
      else if (result === "SKIPPED") summary.skipped += 1;
      else summary.notificationsFailed += 1;
    }

    return summary;
  }

  /**
   * Atomically leases pending rows. The conditional updateMany is the whole
   * mechanism: exactly one dispatcher can move a row from "unclaimed or stale"
   * to "claimed by me", so two consumers can never send the same message
   * concurrently. No transaction is held across the Telegram call.
   */
  private async claimCriticalAlerts(limit: number, now: Date): Promise<PendingItem[]> {
    const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
    const candidates = await this.prisma.criticalAlert.findMany({
      where: {
        status: { in: ["PENDING", "FAILED"] },
        attempts: { lt: MAX_RETRYABLE_ATTEMPTS },
        OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, dedupeKey: true, attempts: true, claimedAt: true },
    });

    const claimed: PendingItem[] = [];
    for (const candidate of candidates) {
      const token = randomUUID();
      const won = await this.prisma.criticalAlert.updateMany({
        where: {
          id: candidate.id,
          status: { in: ["PENDING", "FAILED"] },
          // Re-assert the exact lease we saw; a racing dispatcher that already
          // claimed it will have changed this and we simply skip the row.
          claimedAt: candidate.claimedAt,
        },
        data: { claimedAt: now, claimOwner: token, attempts: { increment: 1 } },
      });
      if (won.count === 1) {
        claimed.push({
          kind: "CRITICAL",
          id: candidate.id,
          reference: candidate.dedupeKey.slice(0, 8),
          attempts: candidate.attempts + 1,
        });
      }
    }
    return claimed;
  }

  private async claimNotifications(limit: number, now: Date): Promise<PendingItem[]> {
    const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
    const candidates = await this.prisma.executionNotification.findMany({
      where: {
        deliveryStatus: { in: ["PENDING", "RETRYABLE_FAILURE"] },
        attemptCount: { lt: MAX_RETRYABLE_ATTEMPTS },
        OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
      },
      // Chronological, then causal within a batch, then stable by id: a restart
      // can never deliver CLOSED_TP before POSITION_FILLED.
      orderBy: [{ createdAt: "asc" }, { milestoneSequence: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, dedupeKey: true, attemptCount: true, claimedAt: true },
    });

    const claimed: PendingItem[] = [];
    for (const candidate of candidates) {
      const token = randomUUID();
      const won = await this.prisma.executionNotification.updateMany({
        where: {
          id: candidate.id,
          deliveryStatus: { in: ["PENDING", "RETRYABLE_FAILURE"] },
          claimedAt: candidate.claimedAt,
        },
        data: { claimedAt: now, claimOwner: token, attemptCount: { increment: 1 } },
      });
      if (won.count === 1) {
        claimed.push({
          kind: "NOTIFICATION",
          id: candidate.id,
          reference: candidate.dedupeKey.slice(0, 8),
          attempts: candidate.attemptCount + 1,
        });
      }
    }
    return claimed;
  }

  private async deliverCritical(item: PendingItem, now: Date): Promise<"DELIVERED" | "FAILED" | "SKIPPED"> {
    const alert = await this.prisma.criticalAlert.findUnique({
      where: { id: item.id },
      include: { tradeExecution: { select: { symbol: true, positionSide: true } } },
    });
    if (!alert) return "SKIPPED";

    if (this.destinations.critical === null) {
      await this.releaseCritical(item.id, "TELEGRAM_DESTINATION_UNAVAILABLE", "No critical destination is configured.");
      return "FAILED";
    }

    let text: string;
    try {
      text = formatCriticalNotification(this.criticalInput(alert), item.reference);
    } catch {
      await this.releaseCritical(item.id, "TELEGRAM_FORMATTING_FAILED", "The critical alert could not be formatted.");
      return "FAILED";
    }

    const result = await this.safeSend(this.destinations.critical, text);
    if (result.delivered) {
      await this.prisma.criticalAlert.update({
        where: { id: item.id },
        data: { status: "SENT", sentAt: now, lastError: null, claimedAt: null, claimOwner: null },
      });
      return "DELIVERED";
    }

    await this.releaseCritical(item.id, result.errorCode, result.sanitizedError);
    logger.warn(
      { alertId: item.id, attempts: item.attempts, errorCode: result.errorCode },
      "Critical alert delivery failed — the alert stays durable and retryable"
    );
    return "FAILED";
  }

  private async deliverNotification(item: PendingItem, now: Date): Promise<"DELIVERED" | "FAILED" | "SKIPPED"> {
    const row = await this.prisma.executionNotification.findUnique({ where: { id: item.id } });
    if (!row) return "SKIPPED";

    if (this.destinations.execution === null) {
      await this.releaseNotification(item.id, false, "TELEGRAM_DESTINATION_UNAVAILABLE", "No destination is configured.");
      return "FAILED";
    }

    let text: string;
    try {
      const payload = row.payloadSnapshot as unknown as NotificationPayload;
      if (!payload || typeof payload !== "object" || payload.type !== row.notificationType) {
        await this.releaseNotification(
          item.id,
          // A payload that does not match its own row will never become valid;
          // retrying it forever would be a busy-loop over a local bug.
          true,
          "TELEGRAM_NOTIFICATION_PAYLOAD_INVALID",
          "The stored payload does not match the notification type."
        );
        return "FAILED";
      }
      text = formatExecutionNotification(payload, item.reference);
    } catch {
      await this.releaseNotification(item.id, true, "TELEGRAM_FORMATTING_FAILED", "The notification could not be formatted.");
      return "FAILED";
    }

    const result = await this.safeSend(this.destinations.execution, text);
    if (result.delivered) {
      await this.prisma.executionNotification.update({
        where: { id: item.id },
        data: {
          deliveryStatus: "DELIVERED",
          deliveredAt: now,
          lastAttemptAt: now,
          lastErrorCode: null,
          sanitizedLastError: null,
          claimedAt: null,
          claimOwner: null,
        },
      });
      return "DELIVERED";
    }

    await this.releaseNotification(item.id, !result.retryable, result.errorCode, result.sanitizedError);
    logger.warn(
      { notificationId: item.id, attempts: item.attempts, errorCode: result.errorCode },
      "Execution notification delivery failed — the intent stays durable and retryable"
    );
    return "FAILED";
  }

  /**
   * A sender that throws is treated as a retryable transport failure. The
   * dispatcher must never propagate: a caller in a safety path would otherwise
   * see a Telegram problem as its own failure.
   */
  private async safeSend(
    chatId: string,
    text: string
  ): Promise<{ delivered: boolean; retryable: boolean; errorCode: TelegramDeliveryCode | null; sanitizedError: string | null }> {
    try {
      return await this.sender(chatId, text);
    } catch {
      // The thrown message is DELIBERATELY discarded rather than sanitized. A
      // transport error routinely embeds the request URL, and the Telegram
      // request URL contains the bot token — there is no safe way to quote it,
      // so nothing from it is ever persisted.
      return {
        delivered: false,
        retryable: true,
        errorCode: "TELEGRAM_DELIVERY_RETRYABLE",
        sanitizedError: "Telegram could not be reached.",
      };
    }
  }

  /** Releases the lease and records the failure. Never reverts a delivered row. */
  private async releaseCritical(id: string, code: string | null, message: string | null): Promise<void> {
    await this.prisma.criticalAlert.updateMany({
      where: { id, status: { not: "SENT" } },
      data: {
        status: "FAILED",
        lastError: `${code ?? "TELEGRAM_DELIVERY_RETRYABLE"}: ${safeText(message) ?? "delivery failed"}`.slice(0, 300),
        claimedAt: null,
        claimOwner: null,
      },
    });
  }

  private async releaseNotification(
    id: string,
    permanent: boolean,
    code: string | null,
    message: string | null
  ): Promise<void> {
    await this.prisma.executionNotification.updateMany({
      // A row that reached DELIVERED is never moved back.
      where: { id, deliveryStatus: { not: "DELIVERED" } },
      data: {
        deliveryStatus: permanent ? "PERMANENT_FAILURE" : "RETRYABLE_FAILURE",
        lastAttemptAt: new Date(),
        lastErrorCode: code,
        sanitizedLastError: safeText(message),
        claimedAt: null,
        claimOwner: null,
      },
    });
  }

  /**
   * Maps a Phase 7 CriticalAlert onto the message input. The alert's own
   * sanitized `details` are the only source; nothing is re-derived and the row
   * is never rewritten.
   */
  private criticalInput(alert: {
    reasonCode: string;
    details: Prisma.JsonValue;
    tradeExecution: { symbol: string; positionSide: string };
  }): CriticalNotificationInput {
    const details = (alert.details ?? {}) as Record<string, unknown>;
    const text = (key: string): string | null => {
      const value = details[key];
      return typeof value === "string" ? value : null;
    };
    return {
      symbol: text("symbol") ?? alert.tradeExecution.symbol,
      positionSide: text("positionSide") ?? alert.tradeExecution.positionSide,
      confirmedOpenQuantity: text("confirmedOpenQuantity"),
      protectedStopQuantity: text("protectedStopQuantity"),
      reasonCode: alert.reasonCode,
      requiredAction: text("requiredAction"),
    };
  }

  // -------------------------------------------------------------------------
  // Bounded discovery from durable history
  // -------------------------------------------------------------------------

  /**
   * Processes a bounded batch of lifecycle events that have never been
   * materialized.
   *
   * Discovery is by ABSENCE OF A CHECKPOINT, not by a timestamp watermark: two
   * events can share a `createdAt` to the millisecond, and a watermark would
   * silently skip one of them. Ordering is by `(tradeExecutionId,
   * sequenceNumber)` so the causal order of a recovered batch is the order the
   * lifecycle actually took, and equal timestamps are irrelevant.
   *
   * Each event's notifications and its checkpoint commit in ONE transaction:
   *  - crash before commit  -> the event has no checkpoint and is rediscovered;
   *  - crash after commit   -> both exist, and the unique dedupe key stops a
   *                            replay from creating a second row.
   */
  async materializeFromEvents(
    limit = DEFAULT_DISCOVERY_BATCH_SIZE
  ): Promise<{ processed: number; created: number }> {
    const events = await this.prisma.executionEvent.findMany({
      // An index-backed anti-join on the checkpoint relation. Bounded no matter
      // how large the history grows, and no id list is ever pulled into memory.
      where: { notificationCheckpoint: null },
      orderBy: [{ tradeExecutionId: "asc" }, { sequenceNumber: "asc" }],
      take: limit,
    });

    let processed = 0;
    let created = 0;
    for (const event of events) {
      const context = await this.readContext(event.tradeExecutionId);
      if (!context) continue;

      const record: LifecycleEventRecord = {
        id: event.id,
        tradeExecutionId: event.tradeExecutionId,
        sequenceNumber: event.sequenceNumber,
        eventType: event.eventType,
        toStatus: event.toStatus,
        reasonCode: event.reasonCode,
        message: event.message,
        metadata: (event.metadata ?? null) as Record<string, unknown> | null,
      };

      created += await this.commitMilestones(
        deriveMilestonesFromEvent(record, context),
        event.tradeExecutionId,
        { executionEventId: event.id }
      );
      processed += 1;
    }

    return { processed, created };
  }

  /**
   * The same bounded, checkpointed pass over verified-protection history. This
   * is what makes an earlier "protected 0.10" survive downtime: the mutable
   * protection row only ever shows the latest coverage, but every verification
   * left its own immutable proof behind.
   */
  async materializeFromProtectionHistory(
    limit = DEFAULT_DISCOVERY_BATCH_SIZE
  ): Promise<{ processed: number; created: number }> {
    const verifications = await this.prisma.executionProtectionVerification.findMany({
      where: { notificationCheckpoint: null },
      orderBy: [{ tradeExecutionId: "asc" }, { protectionVersion: "asc" }],
      take: limit,
    });

    let processed = 0;
    let created = 0;
    for (const verification of verifications) {
      const context = await this.readContext(verification.tradeExecutionId);
      if (!context) continue;

      const triggers = await this.protectionTriggers(
        verification.tradeExecutionId,
        verification.generation
      );
      const milestone = deriveMilestoneFromVerification(
        {
          id: verification.id,
          tradeExecutionId: verification.tradeExecutionId,
          protectionVersion: verification.protectionVersion,
          state: verification.state,
          confirmedOpenQuantity: verification.confirmedOpenQuantity.toFixed(),
          protectedStopQuantity: verification.protectedStopQuantity.toFixed(),
          protectedTakeProfitQuantity: verification.protectedTakeProfitQuantity.toFixed(),
          liquidationSafe: verification.liquidationSafe,
          stopTriggerPrice: triggers.stop,
          takeProfitTriggerPrice: triggers.takeProfit,
        },
        context
      );

      created += await this.commitMilestones(
        milestone ? [milestone] : [],
        verification.tradeExecutionId,
        { protectionVerificationId: verification.id }
      );
      processed += 1;
    }

    return { processed, created };
  }

  /**
   * Writes the derived intents and the source's checkpoint atomically.
   *
   * A source that earns no milestone still gets a checkpoint — otherwise every
   * ORDER_RESERVED and STATUS_CHANGED event in the database would be rescanned
   * on every tick, forever.
   */
  private async commitMilestones(
    milestones: DerivedMilestone[],
    tradeExecutionId: string,
    source: { executionEventId: string } | { protectionVerificationId: string }
  ): Promise<number> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        let created = 0;
        for (const milestone of milestones) {
          // A milestone already materialized from live state (or by a racing
          // runner) is not an error — the unique key is the arbiter.
          const existing = await tx.executionNotification.findUnique({
            where: { dedupeKey: milestone.dedupeKey },
            select: { id: true },
          });
          if (existing) continue;

          await tx.executionNotification.create({
            data: {
              tradeExecutionId,
              notificationType: milestone.type,
              dedupeKey: milestone.dedupeKey,
              severity: milestone.severity,
              milestoneSequence: milestone.milestoneSequence,
              payloadSnapshot: sanitizeNotificationPayload(milestone.payload) as Prisma.InputJsonValue,
            },
          });
          created += 1;
        }

        await tx.executionNotificationCheckpoint.create({
          data: { ...source, processedAt: new Date() },
        });
        return created;
      });
    } catch (error) {
      // A concurrent runner committed this exact source first. Its transaction
      // wrote the same rows under the same deterministic keys, so there is
      // nothing left to do and nothing was lost.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return 0;
      throw error;
    }
  }

  /** Frozen trigger prices for one protection generation, or null. */
  private async protectionTriggers(
    tradeExecutionId: string,
    generation: number
  ): Promise<{ stop: string | null; takeProfit: string | null }> {
    const orders = await this.prisma.binanceOrder.findMany({
      where: { tradeExecutionId, generation, role: { in: ["STOP_LOSS", "TAKE_PROFIT"] } },
      select: { role: true, triggerPrice: true },
    });
    const find = (role: string): string | null =>
      orders.find((order) => order.role === role)?.triggerPrice?.toFixed() ?? null;
    return { stop: find("STOP_LOSS"), takeProfit: find("TAKE_PROFIT") };
  }

  /** Supporting execution context. Read-only, and never a quantity source. */
  private async readContext(tradeExecutionId: string): Promise<ExecutionContext | null> {
    const execution = await this.prisma.tradeExecution.findUnique({ where: { id: tradeExecutionId } });
    if (!execution) return null;
    return {
      symbol: execution.symbol,
      direction: execution.direction,
      plannedEntryPrice: execution.plannedEntryPrice.toFixed(),
      plannedQuantity: execution.plannedQuantity.toFixed(),
      selectedLeverage: execution.selectedLeverage,
      riskBudgetUsd: execution.riskBudgetUsd.toFixed(),
      actualExitPrice: execution.actualExitPrice?.toFixed() ?? null,
      realizedPnl: execution.realizedPnl?.toFixed() ?? null,
      tradingFeesUsd: execution.tradingFeesUsd?.toFixed() ?? null,
      fundingPnlUsd: execution.fundingPnlUsd?.toFixed() ?? null,
      decisionReasonCode: execution.decisionReasonCode,
      sanitizedMessage: execution.sanitizedMessage,
    };
  }

  // -------------------------------------------------------------------------
  // The production tick
  // -------------------------------------------------------------------------

  /**
   * One bounded pass: discover, materialize, deliver, return.
   *
   * There is no loop here and no recursion — the scheduler decides when the
   * next pass happens. Nothing in this call can submit or cancel an order,
   * reach Binance, or change any execution row.
   *
   * Never throws: a tick is observability work, and a failure in it must not be
   * able to take down the worker that runs it.
   */
  async runExecutionNotificationTick(options: TickOptions = {}): Promise<TickSummary> {
    const discoveryBatch = options.discoveryBatchSize ?? DEFAULT_DISCOVERY_BATCH_SIZE;

    const summary: TickSummary = {
      eventsProcessed: 0,
      verificationsProcessed: 0,
      notificationsCreated: 0,
      delivery: {
        criticalDelivered: 0,
        criticalFailed: 0,
        notificationsDelivered: 0,
        notificationsFailed: 0,
        skipped: 0,
      },
      failed: false,
    };

    try {
      const fromEvents = await this.materializeFromEvents(discoveryBatch);
      summary.eventsProcessed = fromEvents.processed;
      summary.notificationsCreated += fromEvents.created;

      const fromProtection = await this.materializeFromProtectionHistory(discoveryBatch);
      summary.verificationsProcessed = fromProtection.processed;
      summary.notificationsCreated += fromProtection.created;

      // Critical alerts are claimed and sent first inside this call.
      summary.delivery = await this.dispatchPendingNotifications({ batchSize: options.dispatchBatchSize });
    } catch (error) {
      summary.failed = true;
      logger.error(
        { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" },
        "Execution notification tick failed — trading is unaffected and the outbox stays durable"
      );
    }

    return summary;
  }
}

/**
 * Production wiring: the real Telegram transport and the configured
 * destinations, resolved once at construction.
 *
 * The scheduler that calls `runExecutionNotificationTick()` lives in
 * execution-notification.scheduler.ts and is registered from the existing
 * worker entrypoint. This function adds no timer of its own.
 */
export function createExecutionNotificationService(prisma: PrismaClient): ExecutionNotificationService {
  const sender: ExecutionTelegramSender = (chatId, text) => sendExecutionTelegramMessage(chatId, text);
  return new ExecutionNotificationService(prisma, sender, {
    execution: resolveExecutionChatId(),
    critical: resolveCriticalChatId(),
    deliveryEnabled: telegramDeliveryEnabled(),
  });
}
