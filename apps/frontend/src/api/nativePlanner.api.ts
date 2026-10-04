import { apiClient } from "./client";

/** GET /api/native-planner/status — read-only health of the SEPARATE Native planner worker. */
export interface NativePlannerStatusDto {
  generatedAt: string;
  role: "native-planner";
  queue: string;
  nativeExecutionEnabled: false;
  startedBy: "EXPLICIT_COMMAND_OR_LAUNCHER";
  worker: {
    state: "RUNNING" | "STALE" | "OFF" | "UNREADABLE";
    reason: string;
    startedAt: string | null;
    lastHeartbeatAt: string | null;
    ageSeconds: number | null;
    consumerRunning: boolean | null;
    lastSweep: { at: string; phase: "STARTUP" | "PERIODIC"; inspected: number; recovered: number; alreadyQueued: number; closedAsError: number; queueUnavailable: boolean } | null;
    lastSweepError: string | null;
  };
  connectedConsumers: number | null;
  jobs: { waiting: number; active: number; delayed: number; failed: number; completed: number } | null;
  pendingNativePlans: number | null;
  readiness: "READY" | "DEGRADED" | "DOWN";
}

export const nativePlannerApi = {
  status: () => apiClient.get<NativePlannerStatusDto>("/api/native-planner/status"),
};

/** One truthful line for Trading Control. Pure. */
export function presentNativePlannerStatus(status: NativePlannerStatusDto | null, unreachable: boolean): { label: string; tone: "green" | "yellow" | "red" | "gray"; detail: string } {
  if (unreachable) return { label: "UNKNOWN", tone: "gray", detail: "Planner status could not be read from the backend." };
  if (status === null) return { label: "…", tone: "gray", detail: "Checking the Native planner worker…" };
  const tone = status.readiness === "READY" ? "green" : status.readiness === "DEGRADED" ? "yellow" : "red";
  const parts = [
    status.worker.ageSeconds === null ? "no heartbeat" : `heartbeat ${status.worker.ageSeconds}s ago`,
    `consumers ${status.connectedConsumers ?? "?"}`,
    `waiting ${status.jobs?.waiting ?? "?"}`,
    `PENDING plans ${status.pendingNativePlans ?? "?"}`,
  ];
  if (status.worker.lastSweep !== null) parts.push(`last sweep inspected ${status.worker.lastSweep.inspected}`);
  return { label: status.readiness, tone, detail: parts.join(" · ") };
}
