import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { countsFromWire } from "../src/modules/binance/pre-shutdown-exchange-check";
import {
  effectiveModeFromWire,
  evaluateTransitionPreconditions,
  proveCurrentMode,
  selectedAccountStateFromWire,
  UNREAD_ACCOUNT_STATE,
} from "../src/modules/operator/account-runtime-transition";

/**
 * The transition's reads, exercised over a REAL HTTP round-trip.
 *
 * The pure cases fix what each mapper does with a value. These fix what it
 * does with a BODY -- one that went through `JSON.stringify`, a socket and
 * `JSON.parse`, where an absent field and a field set to `undefined` become
 * the same thing and a number can arrive as a string.
 *
 * That distinction is the whole point of the fix these cover: a control plane
 * too old to report warnings, or one whose body was truncated, must not read
 * as "no warnings". A pure test can pass `undefined` deliberately; only a real
 * body proves the field was genuinely never sent.
 *
 * No Binance client, no database and no launcher process is involved. The
 * server here stands in for one account's control plane.
 */

const LOOPBACK = "127.0.0.1";

/** What a healthy SAFE account's control plane reports. */
const HEALTHY_SAFE = {
  systemState: "SAFE_OFF",
  profile: { isEnabled: false, killSwitchActive: true },
  environmentGates: { globalKillSwitch: true, liveEntryEnabled: false, protectionReady: false },
  capacity: { totalActive: 0, pending: 0, open: 0 },
  manualIntervention: { count: 0 },
  warnings: [],
};

const FLAT_BODY = {
  signedRequestWorks: true,
  nonZeroPositions: { known: true, count: 0 },
  standardOpenOrders: { known: true, count: 0 },
  openAlgoOrders: { known: true, count: 0 },
  flat: true,
  reasons: [],
  generatedAt: "2026-09-29T10:00:00.000Z",
};

describe("reading one control plane over loopback", () => {
  let app: FastifyInstance;
  let base: string;
  /** Swapped per case, so every test drives the SAME route. */
  let statusBody: unknown = HEALTHY_SAFE;
  let flatnessBody: unknown = FLAT_BODY;
  let statusCode = 200;

  beforeAll(async () => {
    app = Fastify();
    app.get("/api/operator/trading-control/status", async (_request, reply) =>
      reply.code(statusCode).send(statusBody)
    );
    app.get("/api/operator/trading-control/exchange-flatness", async () => flatnessBody);
    await app.listen({ host: LOOPBACK, port: 0 });
    const address = app.server.address();
    base = `http://${LOOPBACK}:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await app.close();
  });

  const readStatus = async (): Promise<unknown> => {
    const response = await fetch(`${base}/api/operator/trading-control/status`);
    if (!response.ok) return null;
    return response.json();
  };

  const readFlatness = async () => {
    const response = await fetch(`${base}/api/operator/trading-control/exchange-flatness`);
    if (!response.ok) return null;
    return countsFromWire((await response.json()) as Parameters<typeof countsFromWire>[0]);
  };

  const preconditions = (selected: ReturnType<typeof selectedAccountStateFromWire>, exchange: Awaited<ReturnType<typeof readFlatness>>) =>
    evaluateTransitionPreconditions({
      account: "ACCOUNT_A",
      targetMode: "LIVE_READY",
      selected,
      exchange,
      ownership: { ok: true, value: { controlOwned: true, workerOwned: true } },
      pending: null,
    });

  it("a healthy SAFE account passes every precondition", async () => {
    statusBody = HEALTHY_SAFE;
    flatnessBody = FLAT_BODY;
    const selected = selectedAccountStateFromWire(await readStatus());
    expect(preconditions(selected, await readFlatness())).toEqual({ ok: true });
  });

  it("a body that never sent `warnings` BLOCKS, rather than reading as none", async () => {
    // This is the shape the fix exists for. Over HTTP the field is simply
    // absent -- there is no `undefined` to notice -- and the old
    // `(warnings ?? []).map(...)` turned exactly this into a clean account.
    const { warnings, ...withoutWarnings } = HEALTHY_SAFE;
    expect(warnings).toEqual([]);
    statusBody = withoutWarnings;

    const selected = selectedAccountStateFromWire(await readStatus());
    expect(selected.warnings).toBeNull();

    const verdict = preconditions(selected, await readFlatness());
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("warnings could not be read");
  });

  it("a warning entry with no code BLOCKS the whole list", async () => {
    statusBody = { ...HEALTHY_SAFE, warnings: [{ code: "RUNTIME_ATTESTATION_BLOCKED" }, { message: "?" }] };
    const selected = selectedAccountStateFromWire(await readStatus());
    expect(selected.warnings).toBeNull();
    expect(preconditions(selected, await readFlatness()).ok).toBe(false);
  });

  it("a blocking warning that IS readable blocks by name", async () => {
    statusBody = { ...HEALTHY_SAFE, warnings: [{ code: "MANUAL_INTERVENTION_REQUIRED" }] };
    const selected = selectedAccountStateFromWire(await readStatus());
    expect(selected.warnings).toEqual(["MANUAL_INTERVENTION_REQUIRED"]);
    const verdict = preconditions(selected, await readFlatness());
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("MANUAL_INTERVENTION_REQUIRED");
  });

  it.each([
    ["profile", { ...HEALTHY_SAFE, profile: undefined }],
    ["capacity", { ...HEALTHY_SAFE, capacity: undefined }],
    ["manualIntervention", { ...HEALTHY_SAFE, manualIntervention: undefined }],
    ["systemState", { ...HEALTHY_SAFE, systemState: undefined }],
  ])("a body that never sent `%s` blocks rather than defaulting", async (_label, body) => {
    statusBody = body;
    const selected = selectedAccountStateFromWire(await readStatus());
    expect(preconditions(selected, await readFlatness()).ok).toBe(false);
  });

  it("a control plane that answers with an error is entirely unread", async () => {
    statusCode = 503;
    statusBody = { error: "unavailable" };
    const selected = selectedAccountStateFromWire(await readStatus());
    expect(selected).toEqual(UNREAD_ACCOUNT_STATE);
    expect(preconditions(selected, await readFlatness()).ok).toBe(false);
    statusCode = 200;
  });

  it("the gates it reports classify the mode it has actually LOADED", async () => {
    statusBody = HEALTHY_SAFE;
    expect(effectiveModeFromWire(await readStatus())).toBe("SAFE");

    statusBody = {
      ...HEALTHY_SAFE,
      environmentGates: { globalKillSwitch: false, liveEntryEnabled: true, protectionReady: true },
    };
    expect(effectiveModeFromWire(await readStatus())).toBe("LIVE_READY");
  });

  it("a half-open set of running gates is INVALID, and proves no mode", async () => {
    statusBody = {
      ...HEALTHY_SAFE,
      environmentGates: { globalKillSwitch: false, liveEntryEnabled: true, protectionReady: false },
    };
    const effective = effectiveModeFromWire(await readStatus());
    expect(effective).toBe("INVALID");
    expect(proveCurrentMode({ disk: "SAFE", effective }).ok).toBe(false);
  });

  it("a body that never sent `environmentGates` proves no mode either", async () => {
    statusBody = { ...HEALTHY_SAFE, environmentGates: undefined };
    const effective = effectiveModeFromWire(await readStatus());
    expect(effective).toBeNull();
    expect(proveCurrentMode({ disk: "SAFE", effective }).ok).toBe(false);
  });

  it("a file and a runtime that disagree refuse, naming both", async () => {
    statusBody = HEALTHY_SAFE;
    const proven = proveCurrentMode({ disk: "LIVE_READY", effective: effectiveModeFromWire(await readStatus()) });
    expect(proven.ok).toBe(false);
    expect(proven.ok === false && proven.reasons.join(" ")).toContain("does not match its configuration");
  });

  it("an exchange count reported UNKNOWN arrives UNKNOWN and blocks", async () => {
    statusBody = HEALTHY_SAFE;
    flatnessBody = { ...FLAT_BODY, openAlgoOrders: { known: false, count: null }, flat: false };
    const exchange = await readFlatness();
    expect(exchange?.openAlgoOrders).toEqual({ known: false });

    const verdict = preconditions(selectedAccountStateFromWire(await readStatus()), exchange);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("could not be read");
  });

  it("an exchange body missing a field entirely blocks, rather than reading zero", async () => {
    const { openAlgoOrders, ...withoutAlgo } = FLAT_BODY;
    expect(openAlgoOrders).toBeDefined();
    flatnessBody = withoutAlgo;

    const exchange = await readFlatness();
    expect(exchange?.openAlgoOrders).toEqual({ known: false });
    expect(preconditions(selectedAccountStateFromWire(await readStatus()), exchange).ok).toBe(false);
  });

  it("real exposure reported by the exchange blocks", async () => {
    flatnessBody = { ...FLAT_BODY, nonZeroPositions: { known: true, count: 1 }, flat: false };
    const verdict = preconditions(
      selectedAccountStateFromWire(await readStatus()),
      await readFlatness()
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reasons.join(" ")).toContain("non-zero positions: 1");
  });
});
