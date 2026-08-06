import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { CriticalAlert, PrismaClient } from "@prisma/client";
import { logger } from "../../config/logger";
import { sanitizeMetadata } from "./execution-safety";

/**
 * Phase 7 — durable critical-alert outbox.
 *
 * Protection failures must be visible to a human even when Telegram is down,
 * so the alert is PERSISTED first and delivered afterwards. A safety action
 * never waits for, and is never blocked by, delivery: `raise()` writes the row
 * and returns; sending is a separate best-effort step.
 *
 * Content is sanitized — no credentials, signed URLs, authorization headers,
 * balances, unrelated positions or raw Binance payloads.
 */

export const CRITICAL_ALERT_TYPES = [
  "STOP_NOT_VERIFIED",
  "STOP_SUBMISSION_UNKNOWN",
  "LIQUIDATION_BUFFER_UNSAFE",
  "MARGIN_TOP_UP_FAILED",
  "MARGIN_TOP_UP_RESULT_UNKNOWN",
  "PROTECTION_COVERAGE_INCOMPLETE",
  "EMERGENCY_CLOSE_STARTED",
  "EMERGENCY_CLOSE_FAILED",
  "POSITION_IDENTITY_CONFLICT",
  "SIBLING_CANCELLATION_FAILED",
  "ORPHAN_PROTECTION_ORDER",
] as const;

export type CriticalAlertType = (typeof CRITICAL_ALERT_TYPES)[number];

/** Injected so tests use a fake and never reach Telegram. */
export type CriticalAlertSender = (text: string) => Promise<boolean>;

export interface RaiseAlertInput {
  tradeExecutionId: string;
  alertType: CriticalAlertType;
  reasonCode: string;
  /** Sanitized operational context only — never account or credential data. */
  details: {
    symbol?: string;
    positionSide?: string;
    confirmedOpenQuantity?: string;
    protectedStopQuantity?: string;
    protectionState?: string;
    requiredAction?: string;
  };
  /**
   * Extra discriminator so a genuinely NEW occurrence is not swallowed by
   * dedupe. Repeated reconciliation of the same condition must reuse it.
   */
  dedupeDiscriminator?: string;
}

/** Keys that must never appear in a stored or sent alert. */
const FORBIDDEN_DETAIL_KEYS = ["apikey", "apisecret", "signature", "authorization", "token", "balance", "wallet"];

function buildDedupeKey(input: RaiseAlertInput): string {
  const material = [
    input.tradeExecutionId,
    input.alertType,
    input.reasonCode,
    input.details.protectionState ?? "",
    input.dedupeDiscriminator ?? "",
  ].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export class CriticalAlertService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly sender: CriticalAlertSender
  ) {}

  /**
   * Persists one alert. Idempotent per dedupe key, so repeated reconciliation
   * of the same condition cannot spam identical alerts.
   *
   * Deliberately does NOT send: callers raise the alert and continue with the
   * safety action immediately.
   */
  async raise(input: RaiseAlertInput): Promise<CriticalAlert> {
    const dedupeKey = buildDedupeKey(input);
    const existing = await this.prisma.criticalAlert.findUnique({ where: { dedupeKey } });
    if (existing) return existing;

    const details = this.sanitizeDetails(input.details);
    const message = this.buildMessage(input);

    try {
      return await this.prisma.criticalAlert.create({
        data: {
          tradeExecutionId: input.tradeExecutionId,
          alertType: input.alertType,
          reasonCode: input.reasonCode,
          dedupeKey,
          message,
          details: details as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      // A concurrent raise won the unique race — return its row.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return this.prisma.criticalAlert.findUniqueOrThrow({ where: { dedupeKey } });
      }
      throw error;
    }
  }

  /**
   * Raises inside an existing transaction, so a failure to persist the alert
   * rolls the protection update back with it.
   */
  async raiseInTransaction(tx: Prisma.TransactionClient, input: RaiseAlertInput): Promise<void> {
    const dedupeKey = buildDedupeKey(input);
    const existing = await tx.criticalAlert.findUnique({ where: { dedupeKey } });
    if (existing) return;

    await tx.criticalAlert.create({
      data: {
        tradeExecutionId: input.tradeExecutionId,
        alertType: input.alertType,
        reasonCode: input.reasonCode,
        dedupeKey,
        message: this.buildMessage(input),
        details: this.sanitizeDetails(input.details) as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Best-effort delivery of pending alerts. A send failure marks the row
   * FAILED with a sanitized error and leaves it retryable — it never throws,
   * so no safety path can be blocked by Telegram.
   */
  async flushPending(limit = 20): Promise<{ sent: number; failed: number }> {
    const pending = await this.prisma.criticalAlert.findMany({
      where: { status: { in: ["PENDING", "FAILED"] } },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    let sent = 0;
    let failed = 0;
    for (const alert of pending) {
      let delivered = false;
      let lastError: string | null = null;
      try {
        delivered = await this.sender(alert.message);
      } catch (error) {
        lastError = error instanceof Error ? error.message.slice(0, 300) : "send failed";
      }

      if (delivered) {
        sent += 1;
        await this.prisma.criticalAlert.update({
          where: { id: alert.id },
          data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 }, lastError: null },
        });
      } else {
        failed += 1;
        await this.prisma.criticalAlert.update({
          where: { id: alert.id },
          data: { status: "FAILED", attempts: { increment: 1 }, lastError: lastError ?? "sender returned false" },
        });
        logger.warn({ alertId: alert.id, alertType: alert.alertType }, "Critical alert delivery failed — still queued");
      }
    }

    return { sent, failed };
  }

  private buildMessage(input: RaiseAlertInput): string {
    const lines = [
      `CRITICAL: ${input.alertType}`,
      `Execution: ${input.tradeExecutionId}`,
      `Reason: ${input.reasonCode}`,
    ];
    if (input.details.symbol) lines.push(`Symbol: ${input.details.symbol} ${input.details.positionSide ?? ""}`.trim());
    if (input.details.confirmedOpenQuantity) lines.push(`Open quantity: ${input.details.confirmedOpenQuantity}`);
    if (input.details.protectedStopQuantity) lines.push(`Protected stop: ${input.details.protectedStopQuantity}`);
    if (input.details.protectionState) lines.push(`Protection state: ${input.details.protectionState}`);
    if (input.details.requiredAction) lines.push(`Action: ${input.details.requiredAction}`);
    return lines.join("\n");
  }

  private sanitizeDetails(details: RaiseAlertInput["details"]): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
      if (value === undefined) continue;
      if (FORBIDDEN_DETAIL_KEYS.some((forbidden) => key.toLowerCase().includes(forbidden))) continue;
      output[key] = value;
    }
    return sanitizeMetadata(output) as Record<string, unknown>;
  }
}
