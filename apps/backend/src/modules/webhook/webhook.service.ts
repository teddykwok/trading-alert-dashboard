import type { PrismaClient, AssetType, SignalType } from "@prisma/client";
import { ASSET_TYPES, SIGNAL_TYPES, parseAlertNote } from "@trading-alert-dashboard/shared";
import { tradingViewWebhookSchema, type TradingViewWebhookInput } from "./webhook.schema";
import { isValidWebhookSecret } from "./webhook.security";
import { AlertsService } from "../alerts/alerts.service";
import { ExtremeRRService } from "../extreme-rr/extreme-rr.service";
import { enqueueExtremeRRPlan, enqueueVisionAnalysis } from "../jobs/queue";
import { logger } from "../../config/logger";
import { notifyAlertDuplicate, notifyNewAlert } from "../notifications/notification.service";
import { parseOrNowDate } from "../../utils/date";
import { normalizeTradingSymbol } from "../../utils/symbol";
import { UnauthorizedError, ValidationError } from "../../utils/errors";
import { env } from "../../config/env";
import { CanaryAuthorizationService } from "../execution/canary-authorization.service";
import { resolveExecutionProfile } from "../execution/execution-profile.service";

function normalizeAssetType(value: string): AssetType {
  const upper = value.toUpperCase();
  if (!(ASSET_TYPES as readonly string[]).includes(upper)) {
    throw new ValidationError(`Unsupported assetType "${value}"`, { field: "assetType" });
  }
  return upper as AssetType;
}

function normalizeSignal(value: string): SignalType {
  const upper = value.toUpperCase();
  if (!(SIGNAL_TYPES as readonly string[]).includes(upper)) {
    throw new ValidationError(`Unsupported signal "${value}"`, { field: "signal" });
  }
  return upper as SignalType;
}

export interface WebhookResult {
  id: string;
  status: string;
  duplicate?: boolean;
  duplicateCount?: number;
}

/**
 * Handles the full webhook intake: validate -> authenticate -> normalize ->
 * duplicate check -> persist -> broadcast -> enqueue. Everything after
 * "persist" is either fire-and-forget (socket emit) or queued for the
 * worker, so this function returns as soon as the alert row exists — no
 * screenshot/AI work happens on this path. If the normalized alert matches
 * an existing one within DUPLICATE_SUPPRESSION_WINDOW_SECONDS, no new alert
 * is created at all — see the duplicate-suppression block below.
 */
export async function handleTradingViewWebhook(
  prisma: PrismaClient,
  rawBody: unknown
): Promise<WebhookResult> {
  const parseResult = tradingViewWebhookSchema.safeParse(rawBody);
  if (!parseResult.success) {
    throw new ValidationError("Malformed webhook payload", parseResult.error.flatten());
  }
  const payload: TradingViewWebhookInput = parseResult.data;

  if (!isValidWebhookSecret(payload.secret)) {
    throw new UnauthorizedError("Invalid webhook secret");
  }

  const assetType = normalizeAssetType(payload.assetType);
  const signal = normalizeSignal(payload.signal);
  const indicatorName = payload.indicatorName ?? null;

  // TradingView may send "BINANCE:BTCUSDT" / "NASDAQ:AAPL" instead of a bare
  // symbol. Everything downstream (Binance klines, duplicate suppression,
  // Asset upsert) uses the normalized bare symbol; the original stays intact
  // inside rawPayload. An explicit payload.exchange always wins over an
  // exchange parsed from the symbol prefix.
  const { normalizedSymbol, exchangeFromSymbol } = normalizeTradingSymbol(payload.symbol);
  const exchange = payload.exchange ?? exchangeFromSymbol ?? null;

  const alertsService = new AlertsService(prisma);

  // Duplicate suppression: if the same symbol/assetType/timeframe/signal/
  // indicatorName combination already fired within the suppression window,
  // don't create a new alert, screenshot, or AI analysis job — just bump the
  // existing alert's duplicate counter and tell the dashboard live.
  const suppressionWindowStart = new Date(
    Date.now() - env.DUPLICATE_SUPPRESSION_WINDOW_SECONDS * 1000
  );
  const existingDuplicate = await alertsService.findRecentDuplicate({
    symbol: normalizedSymbol,
    assetType,
    timeframe: payload.timeframe,
    signal,
    indicatorName,
    since: suppressionWindowStart,
  });

  if (existingDuplicate) {
    const updated = await alertsService.registerDuplicate(existingDuplicate.id);
    await notifyAlertDuplicate(updated);

    return {
      id: updated.id,
      status: "IGNORED_DUPLICATE",
      duplicate: true,
      duplicateCount: updated.duplicateCount,
    };
  }

  const asset = await prisma.asset.upsert({
    where: { symbol_assetType: { symbol: normalizedSymbol, assetType } },
    update: { exchange: exchange ?? undefined },
    create: {
      symbol: normalizedSymbol,
      assetType,
      exchange,
    },
  });

  // Never persist the shared secret — rawPayload is exposed verbatim on the
  // alert detail page (and keeps the original, un-normalized symbol).
  // The canary authorization is stripped alongside the secret: rawPayload is
  // rendered verbatim on the alert detail page, and a reusable authorization
  // must never sit there. It is not needed afterwards either — it is consumed
  // and BOUND to this alert below, and that durable binding is what the
  // execution path checks.
  const { secret: _secret, canaryAuthorization: _canary, ...payloadWithoutSecret } = payload;

  // Level context is parsed once here and stored as structured columns for
  // filtering/analytics. The original note stays untouched inside rawPayload;
  // levelPrice/chartTf are not stored (chart timeframe already lives in
  // `timeframe`, levelPrice is derived from the note on read).
  const levelContext = parseAlertNote(payload.note);

  const alert = await alertsService.create({
    assetId: asset.id,
    symbol: normalizedSymbol,
    assetType,
    exchange,
    timeframe: payload.timeframe,
    price: payload.price,
    signal,
    indicatorName,
    indicatorValue: payload.indicatorValue ?? null,
    rawPayload: payloadWithoutSecret,
    triggeredAt: parseOrNowDate(payload.triggeredAt),
    eventType: levelContext.eventType,
    levelColor: levelContext.levelColor,
    sourceTimeframe: levelContext.sourceTimeframe,
    touchDirection: levelContext.touchDirection,
  });

  // Phase 11B.0: bind a one-shot canary authorization to THIS alert, if one
  // accompanied the signal. Doing it here means the raw token never has to be
  // persisted — the durable (authorization -> alert) binding is what the
  // execution path later checks. Strictly best-effort: a canary problem must
  // never reject an otherwise valid alert, and an unbound alert simply cannot
  // become the canary.
  if (payload.canaryAuthorization) {
    try {
      const profile = await resolveExecutionProfile(prisma);
      if (profile.ok) {
        const outcome = await new CanaryAuthorizationService(prisma).consume({
          token: payload.canaryAuthorization,
          executionProfileId: profile.profile.id,
          symbol: normalizedSymbol,
          direction: signal,
          alertId: alert.id,
        });
        // Reason code only — never the token, not even truncated.
        logger.info(
          { alertId: alert.id, canary: outcome.ok ? (outcome.replay ? "REPLAY" : "BOUND") : outcome.reasonCode },
          "Canary authorization evaluated"
        );
      }
    } catch (error) {
      logger.warn(
        { alertId: alert.id, error: error instanceof Error ? error.message : "unknown" },
        "Canary authorization evaluation failed (alert kept)"
      );
    }
  }

  await notifyNewAlert(alert);
  await enqueueVisionAnalysis(alert.id);

  // Extreme RR plan generation for actionable alerts: create the PENDING row
  // and enqueue the background job. Strictly best-effort — a plan scheduling
  // failure must never reject or delete an otherwise valid alert.
  if (signal === "LONG" || signal === "SHORT") {
    try {
      await new ExtremeRRService(prisma).ensurePendingPlan(alert);
      await enqueueExtremeRRPlan(alert.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ alertId: alert.id, error: message }, "Extreme RR plan scheduling failed (alert kept)");
    }
  }

  return { id: alert.id, status: alert.status };
}
