import type { PrismaClient, AssetType, SignalType } from "@prisma/client";
import { ASSET_TYPES, SIGNAL_TYPES } from "@trading-alert-dashboard/shared";
import { tradingViewWebhookSchema, type TradingViewWebhookInput } from "./webhook.schema";
import { isValidWebhookSecret } from "./webhook.security";
import { AlertsService } from "../alerts/alerts.service";
import { enqueueVisionAnalysis } from "../jobs/queue";
import { notifyNewAlert } from "../notifications/notification.service";
import { parseOrNowDate } from "../../utils/date";
import { UnauthorizedError, ValidationError } from "../../utils/errors";

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
}

/**
 * Handles the full webhook intake: validate -> authenticate -> normalize ->
 * persist -> broadcast -> enqueue. Everything after "persist" is either
 * fire-and-forget (socket emit) or queued for the worker, so this function
 * returns as soon as the alert row exists — no screenshot/AI work happens
 * on this path.
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

  const alertsService = new AlertsService(prisma);
  const alert = await alertsService.create({
    assetId: asset.id,
    symbol: payload.symbol,
    assetType,
    exchange: payload.exchange ?? null,
    timeframe: payload.timeframe,
    price: payload.price,
    signal,
    indicatorName: payload.indicatorName ?? null,
    indicatorValue: payload.indicatorValue ?? null,
    rawPayload: payloadWithoutSecret,
    triggeredAt: parseOrNowDate(payload.triggeredAt),
  });

  await notifyNewAlert(alert);
  await enqueueVisionAnalysis(alert.id);

  return { id: alert.id, status: alert.status };
}
