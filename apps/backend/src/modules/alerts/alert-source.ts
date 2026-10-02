import type { AlertSource } from "@prisma/client";
import { AppError } from "../../utils/errors";

/**
 * THE NATIVE EXECUTION FENCE.
 *
 * An alert's `source` says who produced it. TRADINGVIEW alerts arrive through
 * the authenticated webhook and may, behind every existing gate, become plans
 * and executions. NATIVE alerts are written by the native alert emitter for the
 * dashboard ONLY: they never become an Extreme RR plan, are never re-queued for
 * analysis, are never adopted by an execution worker and never create a
 * TradeExecution, an entry, a protection order or a Binance call.
 *
 * There is deliberately no switch here. No environment variable, profile,
 * policy row or flag can make a NATIVE alert executable; changing that is a
 * reviewed code change, not a configuration change.
 */

/** The only source whose alerts may ever reach plans, adoption or execution. */
export const EXECUTABLE_ALERT_SOURCE = "TRADINGVIEW" as const satisfies AlertSource;

/** The native emitter's source. Dashboard delivery only. */
export const NATIVE_ALERT_SOURCE = "NATIVE" as const satisfies AlertSource;

export class NativeAlertExecutionForbiddenError extends AppError {
  readonly code = "NATIVE_ALERT_EXECUTION_FORBIDDEN";

  constructor(stage: string, alertId: string) {
    super(
      `Alert ${alertId} is a NATIVE alert: native alerts are dashboard-only, and ${stage} is hard-disabled for them.`,
      422
    );
    this.name = "NativeAlertExecutionForbiddenError";
  }
}

/** Refuses a NATIVE alert. Used where a row may legitimately be read without the column (e.g. a narrow select). */
export function assertNotNativeAlert(alert: { id: string; source?: AlertSource | null }, stage: string): void {
  if (alert.source === NATIVE_ALERT_SOURCE) throw new NativeAlertExecutionForbiddenError(stage, alert.id);
}

/** Allowlist form: anything that is not positively TRADINGVIEW is refused. */
export function assertExecutableAlertSource(alert: { id: string; source: AlertSource | null | undefined }, stage: string): void {
  if (alert.source !== EXECUTABLE_ALERT_SOURCE) throw new NativeAlertExecutionForbiddenError(stage, alert.id);
}
