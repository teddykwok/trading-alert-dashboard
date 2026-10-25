import { describe, expect, it } from "vitest";

import { ALWAYS_ON_DEFAULTS } from "../src/modules/always-on/always-on-contract";
import { TEDDY_7_ALL_ACTIVE_V1 } from "../src/modules/native-scanner/scanner-profile";
import { FakeMachine, HEALTHY_UNIVERSE, run, startSupervisor, until } from "./helpers/always-on-fake-machine";

/**
 * R3 — A STALE UNIVERSE AFTER THE NETWORK RETURNS GETS ITS NEXT REFRESH. When
 * UNIVERSE_STALE is the ONLY issue left after a confirmed restoration, the heal
 * window extends to the scanner's own next scheduled refresh (+60 s), capped
 * at the restoration plus the refresh interval plus 60 s. A timestamp that is
 * missing, invalid or in the past, any other issue, or no confirmed
 * restoration keeps the existing behaviour.
 */

const P = ALWAYS_ON_DEFAULTS;
const STALE = { ...HEALTHY_UNIVERSE, stale: true };

/** A scanner whose universe went stale during a REST outage the probe saw, and the moment the probe saw it end. */
async function staleAfterRestoredNetwork() {
  const m = new FakeMachine();
  const { supervisor } = await startSupervisor(m);
  await until(m, supervisor, () => supervisor.status().state === "RUNNING");
  m.scannerUniverse = STALE;
  m.network = false;
  await until(m, supervisor, () => m.kinds().includes("NETWORK_UNAVAILABLE"), 40);
  m.network = true;
  await until(m, supervisor, () => m.kinds().includes("NETWORK_RESTORED"), 10);
  const restoredAt = Date.parse((m.incidents().find((i) => i.kind === "NETWORK_RESTORED") as unknown as { at: string }).at);
  return { m, supervisor, restoredAt };
}

const requestedAt = (m: FakeMachine) => {
  const found = m.incidents().find((i) => i.kind === "SCANNER_RECOVERY_REQUESTED") as unknown as { at: string } | undefined;
  return found === undefined ? null : Date.parse(found.at);
};

describe("UNIVERSE_STALE alone after a confirmed restoration waits for the scanner's next refresh", () => {
  it("the cap is the profile's refresh interval plus the 60 s margin", () => {
    expect(P.universeRefreshHealMarginMs).toBe(60_000);
    expect(P.universeRefreshHealMaxMs).toBe((TEDDY_7_ALL_ACTIVE_V1.operations?.universeRefreshMs as number) + P.universeRefreshHealMarginMs);
  });

  it("the scanner refreshes before its deadline: no recovery at all, and the wait is visible as UNIVERSE_REFRESH_PENDING", async () => {
    const { m, supervisor, restoredAt } = await staleAfterRestoredNetwork();
    m.scannerNextRefreshAt = new Date(restoredAt + 250_000).toISOString();
    while (m.now < restoredAt + 200_000) await run(m, supervisor, 1);
    expect(supervisor.status().roles.scanner.reasonCode).toBe("UNIVERSE_REFRESH_PENDING");
    while (m.now < restoredAt + 260_000) await run(m, supervisor, 1);
    m.scannerUniverse = HEALTHY_UNIVERSE;
    await run(m, supervisor, 4);
    expect(requestedAt(m)).toBeNull();
    expect(supervisor.status().state).toBe("RUNNING");
  });

  it("the refresh does not heal it: one recovery at the scanner's next refresh + 60 s, never earlier", async () => {
    const { m, supervisor, restoredAt } = await staleAfterRestoredNetwork();
    const next = restoredAt + 250_000;
    m.scannerNextRefreshAt = new Date(next).toISOString();
    await until(m, supervisor, () => requestedAt(m) !== null, 60);
    const at = requestedAt(m) as number;
    expect(at).toBeGreaterThanOrEqual(next + P.universeRefreshHealMarginMs);
    expect(at).toBeLessThanOrEqual(next + P.universeRefreshHealMarginMs + P.pollMs);
  });

  it("a next refresh far in the future is capped: one recovery at the restoration + refresh interval + 60 s", async () => {
    const { m, supervisor, restoredAt } = await staleAfterRestoredNetwork();
    m.scannerNextRefreshAt = new Date(restoredAt + 10 * 3_600_000).toISOString();
    await until(m, supervisor, () => requestedAt(m) !== null, 60);
    const at = requestedAt(m) as number;
    expect(at).toBeGreaterThanOrEqual(restoredAt + P.universeRefreshHealMaxMs);
    expect(at).toBeLessThanOrEqual(restoredAt + P.universeRefreshHealMaxMs + P.pollMs);
  });
});

describe("anything untrustworthy or additional keeps the existing heal window", () => {
  it.each([
    ["absent", undefined],
    ["not a timestamp", "soon"],
    ["a number", 1_792_900_000_000],
    ["null", null],
    ["in the past", "PAST"],
  ])("a next refresh that is %s: one recovery right after the 120 s heal window", async (_label, value) => {
    const { m, supervisor, restoredAt } = await staleAfterRestoredNetwork();
    m.scannerNextRefreshAt = value === "PAST" ? new Date(restoredAt - 600_000).toISOString() : value;
    await until(m, supervisor, () => requestedAt(m) !== null, 30);
    const at = requestedAt(m) as number;
    expect(at).toBeGreaterThanOrEqual(restoredAt + P.postNetworkGraceMs);
    expect(at).toBeLessThanOrEqual(restoredAt + P.postNetworkGraceMs + P.pollMs);
  });

  it("UNIVERSE_STALE together with another issue (failed symbols): the other issue is not suppressed — recovery after the 120 s heal window", async () => {
    const { m, supervisor, restoredAt } = await staleAfterRestoredNetwork();
    m.scannerNextRefreshAt = new Date(restoredAt + 250_000).toISOString();
    m.scannerUniverse = { ...STALE, liveEligible: STALE.liveEligible - 3, failed: 3 };
    await until(m, supervisor, () => requestedAt(m) !== null, 30);
    expect(requestedAt(m) as number).toBeLessThanOrEqual(restoredAt + P.postNetworkGraceMs + P.pollMs);
  });

  it("no confirmed restoration (the probe never saw an outage): UNIVERSE_STALE is acted on after the grace, as before", async () => {
    const m = new FakeMachine();
    const { supervisor } = await startSupervisor(m);
    await until(m, supervisor, () => supervisor.status().state === "RUNNING");
    m.scannerNextRefreshAt = new Date(m.now + 250_000).toISOString();
    m.scannerUniverse = STALE;
    const staleAt = m.now;
    await until(m, supervisor, () => requestedAt(m) !== null, 30);
    expect((requestedAt(m) as number) - staleAt).toBeLessThanOrEqual(P.degradedGraceMs + 2 * P.pollMs);
  });
});
