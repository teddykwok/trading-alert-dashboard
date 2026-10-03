import { apiClient } from "./client";

/** GET /api/signal-sources/status — read-only status of both signal sources. */
export interface SignalSourcesStatusDto {
  generatedAt: string;
  tradingView: {
    webhook: "READY";
    webhookRoute: string;
    lastReceivedAt: string | null;
    lastReceivedSymbol: string | null;
  };
  native: {
    state: "RUNNING" | "STOPPED" | "STALE" | "UNKNOWN";
    reason: string;
    profileId: string | null;
    profileLabel: string | null;
    runId: string | null;
    engineFingerprintPrefix: string | null;
    targetEligible: number | null;
    acceptedEligible: number | null;
    selected: number | null;
    liveEligible: number | null;
    failed: number | null;
    writtenAt: string | null;
    ageSeconds: number | null;
    freshnessWindowSeconds: number;
    lastDeliveredAt: string | null;
    lastDeliveredSymbol: string | null;
  };
}

export const signalSourcesApi = {
  status: () => apiClient.get<SignalSourcesStatusDto>("/api/signal-sources/status"),
};

/**
 * What the TradingView webhook line says. There is no connection to
 * TradingView and no heartbeat from it, so the words are "Webhook ready",
 * never "connected" — and "no recent alert" is never shown as unhealthy.
 */
export function presentTradingViewSource(status: SignalSourcesStatusDto | null, unreachable: boolean): { webhook: string; tone: "green" | "gray" | "red"; last: string } {
  if (unreachable) return { webhook: "Backend unreachable", tone: "red", last: "Unknown" };
  if (status === null) return { webhook: "Checking…", tone: "gray", last: "…" };
  return {
    webhook: "Webhook ready",
    tone: "green",
    last: status.tradingView.lastReceivedAt === null ? "No TradingView alert received yet" : status.tradingView.lastReceivedAt,
  };
}

/** What the Native scanner line says. Only a fresh, explicit RUNNING reads as running. */
export function presentNativeScanner(status: SignalSourcesStatusDto | null): {
  state: string;
  tone: "green" | "gray" | "yellow" | "red";
  eligible: string;
  live: string;
  run: string;
  profile: string;
} {
  if (status === null) return { state: "UNKNOWN", tone: "gray", eligible: "—", live: "—", run: "—", profile: "—" };
  const n = status.native;
  const tone = n.state === "RUNNING" ? "green" : n.state === "STALE" ? "yellow" : "gray";
  const target = n.targetEligible ?? n.acceptedEligible;
  return {
    state: n.state,
    tone,
    // Accepted eligible symbols of the last run against its target.
    eligible: n.acceptedEligible === null ? "—" : `${n.acceptedEligible}/${target ?? "—"}`,
    // A live count is only meaningful while the run is provably running.
    live: n.state === "RUNNING" && n.liveEligible !== null ? String(n.liveEligible) : "—",
    run: n.runId ?? "—",
    profile: n.profileLabel ?? (n.runId ? "Legacy (explicit flags)" : "—"),
  };
}
