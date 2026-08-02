import { z } from "zod";
import {
  EXTREME_RR_LEVERAGE_PRESETS,
  EXTREME_RR_LOOKBACKS,
} from "@trading-alert-dashboard/shared";

/**
 * The ONLY client-writable plan fields are the two selections. SL/TP,
 * quantities, distances, margins etc. are always calculated server-side from
 * the frozen snapshot — any such value sent by a client is stripped by zod
 * and never trusted.
 */
export const extremeRRSelectionSchema = z
  .object({
    selectedLookback: z
      .union([
        z.literal(EXTREME_RR_LOOKBACKS[0]),
        z.literal(EXTREME_RR_LOOKBACKS[1]),
        z.literal(EXTREME_RR_LOOKBACKS[2]),
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
