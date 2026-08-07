import { describe, expect, it } from "vitest";
import {
  EXECUTION_NOTIFICATION_TYPES,
  buildNotificationDedupeKey,
  canonicalQuantity,
  deriveEarnedMilestones,
  deriveNetPnl,
  type ExecutionNotificationSnapshot,
} from "../src/modules/notifications/execution-notification";
import {
  NOT_AVAILABLE,
  exactDecimal,
  exactMoney,
  formatCriticalNotification,
  formatExecutionNotification,
  safeText,
} from "../src/modules/notifications/execution-notification-format";

/**
 * Phase 9 pure tests: milestone derivation, dedupe identity, financial
 * semantics and message formatting. No database, no network, no Telegram.
 */

// ---------------------------------------------------------------------------
// Snapshot builders
// ---------------------------------------------------------------------------

function snapshot(overrides: Partial<ExecutionNotificationSnapshot> = {}): ExecutionNotificationSnapshot {
  return {
    executionId: "exec-1",
    status: "PLAN_READY",
    symbol: "FRAXUSDT",
    direction: "LONG",
    plannedEntryPrice: "0.2707",
    plannedQuantity: "294",
    selectedLeverage: 21,
    riskBudgetUsd: "1.5",
    executableStopLoss: "0.2656",
    takeProfit: "0.3011",
    averageFillPrice: null,
    actualExitPrice: null,
    realizedPnl: null,
    tradingFeesUsd: null,
    fundingPnlUsd: null,
    exitReason: null,
    decisionReasonCode: null,
    sanitizedMessage: null,
    entryOrder: null,
    protection: null,
    ...overrides,
  };
}

/** An entry order that reconciliation has read back from the exchange. */
function confirmedEntry(overrides: Partial<NonNullable<ExecutionNotificationSnapshot["entryOrder"]>> = {}) {
  return { status: "NEW", executedQuantity: "0", averageFillPrice: null, reconciled: true, ...overrides };
}

function verifiedProtection(
  quantity: string,
  overrides: Partial<NonNullable<ExecutionNotificationSnapshot["protection"]>> = {}
) {
  return {
    state: "PROTECTED",
    confirmedOpenQuantity: quantity,
    protectedStopQuantity: quantity,
    protectedTakeProfitQuantity: quantity,
    liquidationSafe: true,
    stopTriggerPrice: "0.2656",
    takeProfitTriggerPrice: "0.3011",
    ...overrides,
  };
}

function typesOf(input: ExecutionNotificationSnapshot): string[] {
  return deriveEarnedMilestones(input).map((milestone) => milestone.type);
}

// ---------------------------------------------------------------------------
// LIMIT_PLACED
// ---------------------------------------------------------------------------

describe("LIMIT_PLACED", () => {
  it("is earned once the entry order is confirmed accepted by reconciliation", () => {
    const milestones = deriveEarnedMilestones(
      snapshot({ status: "ENTRY_PENDING", entryOrder: confirmedEntry() })
    );
    expect(milestones.map((m) => m.type)).toEqual(["LIMIT_PLACED"]);
    expect(milestones[0].payload).toMatchObject({
      symbol: "FRAXUSDT",
      direction: "LONG",
      plannedEntryPrice: "0.2707",
      plannedQuantity: "294",
      selectedLeverage: 21,
      riskBudgetUsd: "1.5",
    });
  });

  it("is NOT earned from a bare submission ACK", () => {
    // POST returned, nothing has read the order back: reconciled === false.
    expect(
      typesOf(
        snapshot({ status: "ENTRY_SUBMITTING", entryOrder: confirmedEntry({ status: "SUBMITTING", reconciled: false }) })
      )
    ).toEqual([]);
  });

  it("is NOT earned from a status alone with no persisted entry order", () => {
    // TradeExecution.status says ENTRY_PENDING but nothing proves it.
    expect(typesOf(snapshot({ status: "ENTRY_PENDING", entryOrder: null }))).toEqual([]);
  });

  it("is NOT earned for a rejected or unknown order", () => {
    for (const status of ["REJECTED", "UNKNOWN", "PLANNED", "SUBMITTING"]) {
      expect(typesOf(snapshot({ status: "ENTRY_PENDING", entryOrder: confirmedEntry({ status }) })), status).toEqual([]);
    }
  });

  it("produces a stable dedupe key across repeated derivation", () => {
    const input = snapshot({ status: "ENTRY_PENDING", entryOrder: confirmedEntry() });
    expect(deriveEarnedMilestones(input)[0].dedupeKey).toBe(deriveEarnedMilestones(input)[0].dedupeKey);
    expect(deriveEarnedMilestones(input)[0].dedupeKey).toBe(
      buildNotificationDedupeKey("exec-1", "LIMIT_PLACED", "")
    );
  });
});

// ---------------------------------------------------------------------------
// PARTIAL_FILL
// ---------------------------------------------------------------------------

describe("PARTIAL_FILL", () => {
  const partial = (executedQuantity: string, plannedQuantity = "0.25") =>
    snapshot({
      status: "PARTIALLY_FILLED",
      plannedQuantity,
      entryOrder: confirmedEntry({ status: "PARTIALLY_FILLED", executedQuantity, averageFillPrice: "0.2707" }),
    });

  it("is earned strictly between nothing and everything", () => {
    const milestones = deriveEarnedMilestones(partial("0.10"));
    expect(milestones.map((m) => m.type)).toEqual(["LIMIT_PLACED", "PARTIAL_FILL"]);
    expect(milestones[1].payload).toMatchObject({
      filledQuantity: "0.1",
      plannedQuantity: "0.25",
      averageFillPrice: "0.2707",
    });
  });

  it("dedupes on the cumulative quantity, so a repeated observation is silent", () => {
    const first = deriveEarnedMilestones(partial("0.10")).find((m) => m.type === "PARTIAL_FILL")!;
    const again = deriveEarnedMilestones(partial("0.10")).find((m) => m.type === "PARTIAL_FILL")!;
    expect(again.dedupeKey).toBe(first.dedupeKey);
  });

  it("treats 0.10, 0.1 and 0.100 as the same cumulative fill", () => {
    const keys = ["0.10", "0.1", "0.100"].map(
      (quantity) => deriveEarnedMilestones(partial(quantity)).find((m) => m.type === "PARTIAL_FILL")!.dedupeKey
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("earns a new milestone when the cumulative quantity increases", () => {
    const first = deriveEarnedMilestones(partial("0.10")).find((m) => m.type === "PARTIAL_FILL")!;
    const second = deriveEarnedMilestones(partial("0.15")).find((m) => m.type === "PARTIAL_FILL")!;
    expect(second.dedupeKey).not.toBe(first.dedupeKey);
  });

  it("walks the documented observation sequence to exactly two partials and one fill", () => {
    // Exchange reports 0.10, 0.10, 0.10, 0.15, 0.15, 0.25 (planned 0.25).
    const observations = ["0.10", "0.10", "0.10", "0.15", "0.15", "0.25"];
    const emitted = new Set<string>();
    const sent: string[] = [];

    for (const observed of observations) {
      const full = observed === "0.25";
      const state = full
        ? snapshot({
            status: "ENTRY_FILLED",
            plannedQuantity: "0.25",
            entryOrder: confirmedEntry({ status: "FILLED", executedQuantity: observed, averageFillPrice: "0.2707" }),
          })
        : partial(observed);

      for (const milestone of deriveEarnedMilestones(state)) {
        if (emitted.has(milestone.dedupeKey)) continue;
        emitted.add(milestone.dedupeKey);
        const quantity = milestone.payload.filledQuantity ?? "";
        sent.push(quantity ? `${milestone.type} ${quantity}` : milestone.type);
      }
    }

    expect(sent).toEqual(["LIMIT_PLACED", "PARTIAL_FILL 0.1", "PARTIAL_FILL 0.15", "POSITION_FILLED 0.25"]);
  });

  it("never announces the final full quantity as a partial fill", () => {
    const full = snapshot({
      status: "ENTRY_FILLED",
      plannedQuantity: "0.25",
      entryOrder: confirmedEntry({ status: "FILLED", executedQuantity: "0.25" }),
    });
    expect(typesOf(full)).not.toContain("PARTIAL_FILL");
  });

  it("stays silent while nothing has filled", () => {
    expect(typesOf(partial("0"))).toEqual(["LIMIT_PLACED"]);
  });
});

// ---------------------------------------------------------------------------
// POSITION_FILLED
// ---------------------------------------------------------------------------

describe("POSITION_FILLED", () => {
  it("requires the entry order itself to be FILLED", () => {
    const filled = snapshot({
      status: "ENTRY_FILLED",
      entryOrder: confirmedEntry({ status: "FILLED", executedQuantity: "294", averageFillPrice: "0.2707" }),
    });
    const milestone = deriveEarnedMilestones(filled).find((m) => m.type === "POSITION_FILLED")!;
    expect(milestone.payload).toMatchObject({ filledQuantity: "294", plannedQuantity: "294", averageFillPrice: "0.2707" });
  });

  it("is not implied by the execution status alone", () => {
    expect(
      typesOf(snapshot({ status: "ENTRY_FILLED", entryOrder: confirmedEntry({ status: "PARTIALLY_FILLED", executedQuantity: "1" }) }))
    ).not.toContain("POSITION_FILLED");
  });
});

// ---------------------------------------------------------------------------
// POSITION_PROTECTED
// ---------------------------------------------------------------------------

describe("POSITION_PROTECTED", () => {
  const protectedAt = (quantity: string, overrides = {}) =>
    snapshot({ status: "PROTECTED", protection: verifiedProtection(quantity, overrides) });

  it("is earned only on verified full coverage of the confirmed exposure", () => {
    const milestone = deriveEarnedMilestones(protectedAt("294")).find((m) => m.type === "POSITION_PROTECTED")!;
    expect(milestone.payload).toMatchObject({ protectedQuantity: "294", stopPrice: "0.2656", takeProfitPrice: "0.3011" });
  });

  it("is NOT earned when the execution says PROTECTED but the protection row disagrees", () => {
    expect(typesOf(snapshot({ status: "PROTECTED", protection: null }))).toEqual([]);
    expect(
      typesOf(snapshot({ status: "PROTECTED", protection: verifiedProtection("294", { state: "PROTECTION_INCOMPLETE" }) }))
    ).toEqual([]);
  });

  it("is NOT earned when the stop covers less than the open exposure", () => {
    expect(typesOf(protectedAt("294", { protectedStopQuantity: "100" }))).toEqual([]);
  });

  it("is NOT earned when only the stop is placed and take profit is short", () => {
    expect(typesOf(protectedAt("294", { protectedTakeProfitQuantity: "0" }))).toEqual([]);
  });

  it("is NOT earned when liquidation safety is unproven", () => {
    expect(typesOf(protectedAt("294", { liquidationSafe: null }))).toEqual([]);
    expect(typesOf(protectedAt("294", { liquidationSafe: false }))).toEqual([]);
  });

  it("is NOT earned for a zero exposure", () => {
    expect(typesOf(protectedAt("0"))).toEqual([]);
  });

  it("dedupes on the verified protected quantity", () => {
    const first = deriveEarnedMilestones(protectedAt("0.10")).find((m) => m.type === "POSITION_PROTECTED")!;
    const same = deriveEarnedMilestones(protectedAt("0.10")).find((m) => m.type === "POSITION_PROTECTED")!;
    const larger = deriveEarnedMilestones(protectedAt("0.25")).find((m) => m.type === "POSITION_PROTECTED")!;

    // Re-verifying the same coverage is not a new milestone...
    expect(same.dedupeKey).toBe(first.dedupeKey);
    // ...but a tranche that protects a larger exposure is.
    expect(larger.dedupeKey).not.toBe(first.dedupeKey);
  });
});

// ---------------------------------------------------------------------------
// ENTRY_EXPIRED
// ---------------------------------------------------------------------------

describe("ENTRY_EXPIRED", () => {
  it("is earned when the terminal status and zero confirmed exposure agree", () => {
    expect(
      typesOf(
        snapshot({
          status: "ENTRY_EXPIRED",
          entryOrder: confirmedEntry({ status: "EXPIRED", executedQuantity: "0" }),
          protection: verifiedProtection("0", { state: "CLOSED", liquidationSafe: null }),
        })
      )
    ).toContain("ENTRY_EXPIRED");
  });

  it("is NOT earned while live exposure remains after a partial-fill cancellation", () => {
    expect(
      typesOf(
        snapshot({
          status: "ENTRY_EXPIRED",
          plannedQuantity: "0.25",
          entryOrder: confirmedEntry({ status: "CANCELED", executedQuantity: "0.10" }),
          protection: verifiedProtection("0.10", { state: "PROTECTED", liquidationSafe: true }),
        })
      )
    ).not.toContain("ENTRY_EXPIRED");
  });

  it("is NOT earned when nothing can prove the position is flat", () => {
    // Partially filled, no protection row: exposure is unknown, so stay silent.
    expect(
      typesOf(
        snapshot({
          status: "ENTRY_EXPIRED",
          plannedQuantity: "0.25",
          entryOrder: confirmedEntry({ status: "CANCELED", executedQuantity: "0.10" }),
          protection: null,
        })
      )
    ).not.toContain("ENTRY_EXPIRED");
  });
});

// ---------------------------------------------------------------------------
// Closures and skips
// ---------------------------------------------------------------------------

describe("closures", () => {
  const closed = (status: string) =>
    snapshot({
      status,
      actualExitPrice: "0.3011",
      realizedPnl: "3",
      tradingFeesUsd: "0.15",
      fundingPnlUsd: "-0.02",
    });

  it("earns exactly one milestone per terminal closure status", () => {
    for (const status of ["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY"]) {
      const milestones = deriveEarnedMilestones(closed(status)).filter((m) => m.type === status);
      expect(milestones, status).toHaveLength(1);
      expect(milestones[0].payload.netPnlUsd, status).toBe("2.83");
    }
  });

  it("earns nothing for a non-terminal state that merely started closing", () => {
    expect(typesOf(snapshot({ status: "PLACING_PROTECTION", protection: verifiedProtection("1", { state: "EMERGENCY_CLOSING" }) }))).toEqual(
      []
    );
  });

  it("keeps closure dedupe keys distinct per type", () => {
    const keys = ["CLOSED_TP", "CLOSED_SL", "CLOSED_EMERGENCY"].map(
      (status) => deriveEarnedMilestones(closed(status))[0].dedupeKey
    );
    expect(new Set(keys).size).toBe(3);
  });
});

describe("TRADE_SKIPPED", () => {
  it("is earned only for terminal SKIPPED", () => {
    const milestone = deriveEarnedMilestones(
      snapshot({
        status: "SKIPPED",
        decisionReasonCode: "MAX_OPEN_POSITIONS_REACHED",
        sanitizedMessage: "Open position capacity is exhausted.",
      })
    )[0];
    expect(milestone.type).toBe("TRADE_SKIPPED");
    expect(milestone.severity).toBe("WARNING");
    expect(milestone.payload).toMatchObject({
      reasonCode: "MAX_OPEN_POSITIONS_REACHED",
      explanation: "Open position capacity is exhausted.",
    });
  });

  it("is NOT earned for a retryable decision that left the execution alive", () => {
    for (const status of ["PLAN_READY", "PREFLIGHT"]) {
      expect(
        typesOf(snapshot({ status, decisionReasonCode: "BINANCE_STATE_UNAVAILABLE" })),
        status
      ).not.toContain("TRADE_SKIPPED");
    }
    expect(typesOf(snapshot({ status: "PLAN_READY", decisionReasonCode: "CAPACITY_CONFLICT_RETRY" }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe("causal ordering", () => {
  it("never places a closure before the fill it closes", () => {
    const milestones = deriveEarnedMilestones(
      snapshot({
        status: "CLOSED_TP",
        plannedQuantity: "294",
        entryOrder: confirmedEntry({ status: "FILLED", executedQuantity: "294" }),
        protection: verifiedProtection("294"),
        realizedPnl: "3",
      })
    );
    const order = milestones.map((m) => m.type);
    expect(order.indexOf("LIMIT_PLACED")).toBeLessThan(order.indexOf("POSITION_FILLED"));
    expect(order.indexOf("POSITION_FILLED")).toBeLessThan(order.indexOf("POSITION_PROTECTED"));
    expect(order.indexOf("POSITION_PROTECTED")).toBeLessThan(order.indexOf("CLOSED_TP"));
  });

  it("assigns a strictly increasing sequence to the causal chain", () => {
    const sequences = deriveEarnedMilestones(
      snapshot({
        status: "CLOSED_SL",
        entryOrder: confirmedEntry({ status: "FILLED", executedQuantity: "294" }),
        protection: verifiedProtection("294"),
      })
    ).map((m) => m.milestoneSequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// Financial semantics
// ---------------------------------------------------------------------------

describe("net PnL", () => {
  it("computes realized - fees + funding when everything is known", () => {
    expect(deriveNetPnl("3", "0.15", "-0.02")).toBe("2.83");
    expect(deriveNetPnl("3", "0.15", "0.02")).toBe("2.87");
  });

  it("is null when any single component is unknown", () => {
    expect(deriveNetPnl(null, "0.15", "0")).toBeNull();
    expect(deriveNetPnl("3", null, "0")).toBeNull();
    expect(deriveNetPnl("3", "0.15", null)).toBeNull();
  });

  it("treats a zero fee as known, not as missing", () => {
    expect(deriveNetPnl("3", "0", "0")).toBe("3");
  });

  it("preserves a negative realized result", () => {
    expect(deriveNetPnl("-1.25", "0.10", "-0.05")).toBe("-1.4");
  });

  it("does not drift the way floating point would", () => {
    // 0.1 + 0.2 - 0.3 is exactly 0 here; in IEEE 754 doubles it is not.
    expect(deriveNetPnl("0.1", "-0.2", "-0.3")).toBe("0");
    expect(deriveNetPnl("100.05", "0.1", "0")).toBe("99.95");
  });
});

describe("canonical quantity", () => {
  it("normalizes representation without changing value", () => {
    expect(canonicalQuantity("0.10")).toBe("0.1");
    expect(canonicalQuantity("294.000")).toBe("294");
    expect(canonicalQuantity("0")).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe("value formatting", () => {
  it("renders null as Not available and zero as zero", () => {
    expect(exactDecimal(null)).toBe(NOT_AVAILABLE);
    expect(exactMoney(null)).toBe(NOT_AVAILABLE);
    expect(exactMoney("0")).toBe("$0");
    expect(exactDecimal("0")).toBe("0");
  });

  it("keeps a negative amount negative", () => {
    expect(exactMoney("-0.02")).toBe("-$0.02");
    expect(exactMoney("-1.25")).toBe("-$1.25");
  });

  it("drops trailing zeros without rounding or truncating", () => {
    expect(exactDecimal("0.270700000000")).toBe("0.2707");
    // Full precision survives — no silent rounding to a shorter value.
    expect(exactDecimal("1.123456789012345")).toBe("1.123456789012345");
  });

  it("flattens a multi-line value into one bounded field", () => {
    expect(safeText("first\nsecond")).toBe("first second");
    expect(safeText("   ")).toBeNull();
    expect(safeText("x".repeat(500))!.length).toBeLessThanOrEqual(160);
  });
});

describe("messages", () => {
  const render = (input: ExecutionNotificationSnapshot, type: string): string => {
    const milestone = deriveEarnedMilestones(input).find((m) => m.type === type)!;
    return formatExecutionNotification(milestone.payload, milestone.dedupeKey.slice(0, 8));
  };

  it("formats a LONG limit placement", () => {
    const text = render(snapshot({ status: "ENTRY_PENDING", entryOrder: confirmedEntry() }), "LIMIT_PLACED");
    expect(text).toContain("🟦 LIMIT PLACED");
    expect(text).toContain("FRAXUSDT · LONG");
    expect(text).toContain("Entry: 0.2707");
    expect(text).toContain("Quantity: 294");
    expect(text).toContain("Leverage: 21x");
    expect(text).toContain("Risk: $1.5");
  });

  it("formats a SHORT direction verbatim", () => {
    const text = render(
      snapshot({ status: "ENTRY_PENDING", direction: "SHORT", entryOrder: confirmedEntry() }),
      "LIMIT_PLACED"
    );
    expect(text).toContain("FRAXUSDT · SHORT");
  });

  it("formats a partial fill and never shows an unknown average as 0", () => {
    const text = render(
      snapshot({
        status: "PARTIALLY_FILLED",
        plannedQuantity: "294",
        entryOrder: confirmedEntry({ status: "PARTIALLY_FILLED", executedQuantity: "100", averageFillPrice: null }),
      }),
      "PARTIAL_FILL"
    );
    expect(text).toContain("🟨 PARTIAL FILL");
    expect(text).toContain("Filled: 100 / 294");
    expect(text).toContain(`Average: ${NOT_AVAILABLE}`);
    expect(text).not.toContain("Average: 0");
  });

  it("does not imply a filled position is protected", () => {
    const text = render(
      snapshot({ status: "ENTRY_FILLED", entryOrder: confirmedEntry({ status: "FILLED", executedQuantity: "294", averageFillPrice: "0.2707" }) }),
      "POSITION_FILLED"
    );
    expect(text).toContain("🟩 POSITION FILLED");
    expect(text).toContain("Protection verification in progress.");
    expect(text).not.toContain("PROTECTED");
  });

  it("formats verified protection with the frozen trigger prices", () => {
    const text = render(snapshot({ status: "PROTECTED", protection: verifiedProtection("294") }), "POSITION_PROTECTED");
    expect(text).toContain("🛡 POSITION PROTECTED");
    expect(text).toContain("Protected quantity: 294");
    expect(text).toContain("SL: 0.2656");
    expect(text).toContain("TP: 0.3011");
    expect(text).toContain("STOP and TAKE PROFIT coverage verified.");
  });

  it("formats an expiry as carrying no exposure", () => {
    const text = render(
      snapshot({ status: "ENTRY_EXPIRED", entryOrder: confirmedEntry({ status: "EXPIRED", executedQuantity: "0" }) }),
      "ENTRY_EXPIRED"
    );
    expect(text).toContain("⌛ ENTRY EXPIRED");
    expect(text).toContain("No live exposure remains.");
  });

  it("formats a take-profit closure with a complete financial block", () => {
    const text = render(
      snapshot({ status: "CLOSED_TP", actualExitPrice: "0.3011", realizedPnl: "3", tradingFeesUsd: "0.15", fundingPnlUsd: "-0.02" }),
      "CLOSED_TP"
    );
    expect(text).toContain("✅ CLOSED — TAKE PROFIT");
    expect(text).toContain("Exit: 0.3011");
    expect(text).toContain("Realized PnL: $3");
    expect(text).toContain("Fees: $0.15");
    expect(text).toContain("Funding: -$0.02");
    expect(text).toContain("Net PnL: $2.83");
  });

  it("says Not available rather than $0.00 for unknown fees and funding", () => {
    const text = render(
      snapshot({ status: "CLOSED_SL", actualExitPrice: "0.2656", realizedPnl: "-1.5", tradingFeesUsd: null, fundingPnlUsd: null }),
      "CLOSED_SL"
    );
    expect(text).toContain("🛑 CLOSED — STOP LOSS");
    expect(text).toContain("Realized PnL: -$1.5");
    expect(text).toContain(`Fees: ${NOT_AVAILABLE}`);
    expect(text).toContain(`Funding: ${NOT_AVAILABLE}`);
    expect(text).toContain(`Net PnL: ${NOT_AVAILABLE}`);
    expect(text).not.toContain("$0.00");
  });

  it("shows a zero fee as zero, distinct from unknown", () => {
    const text = render(
      snapshot({ status: "CLOSED_TP", realizedPnl: "3", tradingFeesUsd: "0", fundingPnlUsd: "0" }),
      "CLOSED_TP"
    );
    expect(text).toContain("Fees: $0");
    expect(text).toContain("Net PnL: $3");
  });

  it("identifies an emergency closure without dressing it as TP or SL", () => {
    const text = render(snapshot({ status: "CLOSED_EMERGENCY", realizedPnl: "-2" }), "CLOSED_EMERGENCY");
    expect(text).toContain("🚨 CLOSED — EMERGENCY");
    expect(text).toContain("Position closure verified.");
    expect(text).toContain("Realized PnL: -$2");
    expect(text).not.toContain("TAKE PROFIT");
    expect(text).not.toContain("STOP LOSS");
  });

  it("formats a skip with its stable reason code", () => {
    const text = render(
      snapshot({ status: "SKIPPED", decisionReasonCode: "SIGNAL_TOO_OLD", sanitizedMessage: "Signal age exceeded the freshness window." }),
      "TRADE_SKIPPED"
    );
    expect(text).toContain("⏭ TRADE SKIPPED");
    expect(text).toContain("Reason: SIGNAL_TOO_OLD");
    expect(text).toContain("Signal age exceeded the freshness window.");
  });

  it("neutralizes Telegram markup and newline injection in dynamic fields", () => {
    const text = render(
      snapshot({
        status: "SKIPPED",
        symbol: "*BTC*USDT_[x]`",
        decisionReasonCode: "REASON_<b>code</b>",
        sanitizedMessage: "line one\nline two\r\n_underscored_",
      }),
      "TRADE_SKIPPED"
    );
    // Plain text is sent (no parse_mode), so markup characters are inert and
    // survive verbatim rather than being mangled by a broken escape scheme.
    expect(text).toContain("*BTC*USDT_[x]`");
    // Newlines inside a field cannot forge additional message lines.
    expect(text).toContain("line one line two _underscored_");
    expect(text.split("\n").filter((line) => line.startsWith("Reason:"))).toHaveLength(1);
  });

  it("carries a stable reference so a redelivered duplicate is recognisable", () => {
    const input = snapshot({ status: "ENTRY_PENDING", entryOrder: confirmedEntry() });
    expect(render(input, "LIMIT_PLACED")).toBe(render(input, "LIMIT_PLACED"));
    expect(render(input, "LIMIT_PLACED")).toMatch(/\nRef: [0-9a-f]{8}$/);
  });

  it("leaks no credential, balance or account data in any message", () => {
    const everything = [
      snapshot({ status: "ENTRY_PENDING", entryOrder: confirmedEntry() }),
      snapshot({ status: "PROTECTED", protection: verifiedProtection("294") }),
      snapshot({ status: "CLOSED_TP", realizedPnl: "3", tradingFeesUsd: "0.1", fundingPnlUsd: "0" }),
      snapshot({ status: "SKIPPED", decisionReasonCode: "SIGNAL_TOO_OLD" }),
    ];
    for (const input of everything) {
      for (const milestone of deriveEarnedMilestones(input)) {
        const text = formatExecutionNotification(milestone.payload, "abcd1234").toLowerCase();
        for (const forbidden of [
          "apikey",
          "apisecret",
          "signature",
          "authorization",
          "bot",
          "chat_id",
          "balance",
          "wallet",
          "accountidentifier",
          "tad-en-",
        ]) {
          expect(`${milestone.type}:${text.includes(forbidden)}`).toBe(`${milestone.type}:false`);
        }
      }
    }
  });
});

describe("critical message", () => {
  it("renders the sanitized Phase 7 alert content", () => {
    const text = formatCriticalNotification(
      {
        symbol: "FRAXUSDT",
        positionSide: "LONG",
        confirmedOpenQuantity: "294",
        protectedStopQuantity: "100",
        reasonCode: "STOP_NOT_VERIFIED",
        requiredAction: "Verify the stop on Binance.",
      },
      "abcd1234"
    );
    expect(text).toContain("🚨 CRITICAL — PROTECTION FAILURE");
    expect(text).toContain("FRAXUSDT · LONG");
    expect(text).toContain("Exposure: 294");
    expect(text).toContain("Stop protected: 100");
    expect(text).toContain("Reason: STOP_NOT_VERIFIED");
    expect(text).toContain("Manual intervention may be required.");
  });

  it("shows an unknown quantity as Not available, never as zero", () => {
    const text = formatCriticalNotification(
      {
        symbol: "FRAXUSDT",
        positionSide: null,
        confirmedOpenQuantity: null,
        protectedStopQuantity: null,
        reasonCode: "STOP_SUBMISSION_UNKNOWN",
        requiredAction: null,
      },
      "abcd1234"
    );
    expect(text).toContain(`Exposure: ${NOT_AVAILABLE}`);
    expect(text).toContain(`Stop protected: ${NOT_AVAILABLE}`);
    expect(text).not.toContain("Exposure: 0");
  });
});

describe("type catalogue", () => {
  it("keeps the informational catalogue free of the critical type", () => {
    // CRITICAL_PROTECTION_FAILURE has no ExecutionNotification row: Phase 7's
    // CriticalAlert remains the one durable record for it.
    expect(EXECUTION_NOTIFICATION_TYPES).not.toContain("CRITICAL_PROTECTION_FAILURE" as never);
    expect(EXECUTION_NOTIFICATION_TYPES).toHaveLength(9);
  });
});
