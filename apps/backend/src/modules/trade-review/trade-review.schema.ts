import { z } from "zod";
import { SIGNAL_TYPES, TRADE_MARGIN_MODES, TRADE_REVIEW_STATUSES } from "@trading-alert-dashboard/shared";

/**
 * A decimal-safe price value. Strings are preferred (they preserve exact
 * precision all the way into Prisma's Decimal, e.g. "0.004086"); plain JSON
 * numbers are also accepted for convenience. `null` explicitly clears the
 * stored value, `undefined` leaves it untouched.
 */
const decimalPrice = z
  .union([
    z
      .string()
      .trim()
      .regex(/^\d+(\.\d+)?$/, "must be a plain positive decimal string, e.g. \"0.004086\"")
      .refine((value) => Number(value) > 0, "must be greater than zero"),
    z.number().finite().positive(),
  ])
  .nullable()
  .optional();

/** Positive decimal like prices, but for percent/leverage-style values. */
const decimalPositive = decimalPrice;

export const tradeReviewUpsertSchema = z.object({
  status: z.enum(TRADE_REVIEW_STATUSES).optional(),
  entryPrice: decimalPrice,
  exitPrice: decimalPrice,
  notes: z.string().max(5000).nullable().optional(),
  // Futures risk-planner inputs. Same semantics as the fields above:
  // undefined preserves, null clears, strings keep exact decimal precision.
  stopLossPrice: decimalPrice,
  takeProfitPrice: decimalPrice,
  accountBalance: decimalPrice,
  riskPercent: decimalPositive,
  leverage: z
    .union([
      z
        .string()
        .trim()
        .regex(/^\d+(\.\d+)?$/, 'must be a plain positive decimal string, e.g. "25"')
        .refine((value) => Number(value) >= 1, "must be at least 1"),
      z.number().finite().min(1),
    ])
    .nullable()
    .optional(),
  marginMode: z.enum(TRADE_MARGIN_MODES).nullable().optional(),
  liquidationPrice: decimalPrice,
});

export type TradeReviewUpsertInput = z.infer<typeof tradeReviewUpsertSchema>;

export const tradeReviewStatsQuerySchema = z.object({
  symbol: z.string().min(1).optional(),
  timeframe: z.string().min(1).optional(),
  signal: z.enum(SIGNAL_TYPES).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

export type TradeReviewStatsQuery = z.infer<typeof tradeReviewStatsQuerySchema>;
