import { z } from "zod";
import {
  EXTREME_RR_LEVERAGE_PRESETS,
  EXTREME_RR_LOOKBACKS,
  EXTREME_RR_STATUSES,
  NATIVE_PLAN_DIRECTIONS,
  NATIVE_PLAN_INTEGRITY_FILTERS,
  NATIVE_PLAN_PAGE_MAX_SIZE,
  NATIVE_PLAN_SEARCH_MAX_LENGTH,
  NATIVE_PLAN_SEARCH_PATTERN,
  SOURCE_TIMEFRAMES,
} from "@trading-alert-dashboard/shared";

/**
 * A Native plan PAGE query (GET /api/extreme-rr/native-plans). Strict: an
 * unknown key, a repeated key or any value outside the shared vocabulary is
 * refused (422), never ignored, so a mistyped filter can never come back as
 * an unfiltered page that looks filtered.
 */
export const nativePlanPageQuerySchema = z
  .object({
    pageSize: z
      .string()
      .regex(/^\d{1,3}$/, "pageSize must be an integer")
      .transform(Number)
      .refine((size) => size >= 1 && size <= NATIVE_PLAN_PAGE_MAX_SIZE, `pageSize must be 1..${NATIVE_PLAN_PAGE_MAX_SIZE}`)
      .optional(),
    // Opaque; decoded strictly by the service.
    cursor: z.string().min(1).max(256).optional(),
    q: z.string().trim().min(1).max(NATIVE_PLAN_SEARCH_MAX_LENGTH).regex(NATIVE_PLAN_SEARCH_PATTERN, "q accepts letters and digits only").optional(),
    sourceTimeframe: z.enum(SOURCE_TIMEFRAMES).optional(),
    direction: z.enum(NATIVE_PLAN_DIRECTIONS).optional(),
    planStatus: z.enum(EXTREME_RR_STATUSES).optional(),
    integrity: z.enum(NATIVE_PLAN_INTEGRITY_FILTERS).optional(),
  })
  .strict();

export type NativePlanPageQueryInput = z.infer<typeof nativePlanPageQuerySchema>;

/**
 * The ONLY client-writable plan fields are the two selections. SL/TP,
 * quantities, distances, margins etc. are always calculated server-side from
 * the frozen snapshot — any such value sent by a client is stripped by zod
 * and never trusted.
 */
export const extremeRRSelectionSchema = z
  .object({
    // Derived from the shared vocabulary rather than enumerated by index:
    // the previous three hand-written literals silently stopped covering the
    // list the moment a fourth lookback was added.
    selectedLookback: z
      .union([
        z.literal(EXTREME_RR_LOOKBACKS[0]),
        z.literal(EXTREME_RR_LOOKBACKS[1]),
        ...EXTREME_RR_LOOKBACKS.slice(2).map((value) => z.literal(value)),
      ])
      .optional(),
    // null clears a previously saved leverage; no default is ever assumed.
    selectedLeverage: z
      .union([
        z.literal(EXTREME_RR_LEVERAGE_PRESETS[0]),
        z.literal(EXTREME_RR_LEVERAGE_PRESETS[1]),
        z.literal(EXTREME_RR_LEVERAGE_PRESETS[2]),
        z.literal(EXTREME_RR_LEVERAGE_PRESETS[3]),
        z.literal(EXTREME_RR_LEVERAGE_PRESETS[4]),
      ])
      .nullable()
      .optional(),
  })
  .refine(
    (value) => value.selectedLookback !== undefined || value.selectedLeverage !== undefined,
    "at least one of selectedLookback or selectedLeverage must be provided"
  );

export type ExtremeRRSelectionInput = z.infer<typeof extremeRRSelectionSchema>;
