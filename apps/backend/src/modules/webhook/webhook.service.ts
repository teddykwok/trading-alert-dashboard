import type { PrismaClient, AssetType, SignalType } from "@prisma/client";
import { ASSET_TYPES, SIGNAL_TYPES } from "@trading-alert-dashboard/shared";
import { tradingViewWebhookSchema, type TradingViewWebhookInput } from "./webhook.schema";
import { isValidWebhookSecret } from "./webhook.security";
import { AlertsService } from "../alerts/alerts.service";
import { enqueueVisionAnalysis } from "../jobs/queue";
import { notifyAlertDuplicate, notifyNewAlert } from "../notifications/notification.service";
import { parseOrNowDate } from "../../utils/date";
import { UnauthorizedError, ValidationError } from "../../utils/errors";
import { env } from "../../config/env";

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

  const alertsService = new AlertsService(prisma);

  // Duplicate suppression: if the same symbol/assetType/timeframe/signal/
  // indicatorName combination already fired within the suppression window,
  // don't create a new alert, screenshot, or AI analysis job — just bump the
  // existing alert's duplicate counter and tell the dashboard live.
  const suppressionWindowStart = new Date(
    Date.now() - env.DUPLICATE_SUPPRESSION_WINDOW_SECONDS * 1000
  );
  const existingDuplicate = await alertsService.findRecentDuplicate({
    symbol: payload.symbol,
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
    where: { symbol_assetType: { symbol: payload.symbol, assetType } },
    update: { exchange: payload.exchange ?? undefined },
    create: {
      symbol: payload.symbol,
      assetType,
      exchange: payload.exchange ?? null,
    },
  });

  // Never persist the shared secret — rawPayload is exposed verbatim on the
  // alert detail page.
  const { secret: _secret, ...payloadWithoutSecret } = payload;

  const alert = await alertsService.create({
    assetId: asset.id,
    symbol: payload.symbol,
    assetType,
    exchange: payload.exchange ?? null,
    timeframe: payload.timeframe,
    price: payload.price,
    signal,
    indicatorName,
    indicatorValue: payload.indicatorValue ?? null,
    rawPayload: payloadWithoutSecret,
    triggeredAt: parseOrNowDate(payload.triggeredAt),
  });

  await notifyNewAlert(alert);
  await enqueueVisionAnalysis(alert.id);

  return { id: alert.id, status: alert.status };
}
