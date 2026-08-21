import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { NAV_ITEMS } from "../src/components/layout/Sidebar";

/**
 * Trading Control lives on its own page.
 *
 * It used to sit on the Dashboard between the alert stats and the feed, which
 * meant the one surface showing whether a real-money account is armed competed
 * for attention with a scrolling signal list. Moving it is purely navigation:
 * the card, the operator session, the polling and every safety decision are the
 * same modules, which is what most of this file asserts.
 *
 * The repo has no DOM test environment, so — as `executionPresentation` and the
 * backend's structural suites already do — routing and mounting are asserted
 * from the source and the exported nav table rather than from a render.
 */

const src = (relative: string) =>
  readFileSync(path.join(process.cwd(), "src", relative), "utf8");

describe("trading control page: navigation", () => {
  it("lists Trading Control in the sidebar", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toContain("Trading Control");
  });

  it("sits directly below Executions and above Settings", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      "Dashboard",
      "Risk Templates",
      "Executions",
      "Trading Control",
      "Settings",
    ]);
  });

  it("points at the dedicated route", () => {
    const item = NAV_ITEMS.find((entry) => entry.label === "Trading Control");
    expect(item?.to).toBe("/trading-control");
  });

  it("does not claim an exact-match nav entry", () => {
    // `end: true` belongs to "/" alone. Setting it here would be harmless today
    // but would silently stop the item highlighting if the page ever gains a
    // nested route.
    const item = NAV_ITEMS.find((entry) => entry.label === "Trading Control");
    expect("end" in (item ?? {})).toBe(false);
  });

  it("leaves every pre-existing nav entry untouched", () => {
    // A navigation change must not quietly relabel or repoint anything else.
    expect(NAV_ITEMS.filter((item) => item.label !== "Trading Control")).toEqual([
      { to: "/", label: "Dashboard", end: true },
      { to: "/risk-templates", label: "Risk Templates" },
      { to: "/executions", label: "Executions" },
      { to: "/settings", label: "Settings" },
    ]);
  });
});

describe("trading control page: routing", () => {
  const app = src("App.tsx");

  it("registers the route against the dedicated page", () => {
    expect(app).toContain('<Route path="/trading-control" element={<TradingControlPage />} />');
    expect(app).toContain('import { TradingControlPage } from "./pages/TradingControlPage";');
  });

  it("preserves every route that existed before", () => {
    // Direct navigation and reload work through the same router as every other
    // page, so the only thing that can break them is a lost route.
    for (const route of [
      '<Route path="/" element={<DashboardPage />} />',
      '<Route path="/alerts/:id" element={<AlertDetailPage />} />',
      '<Route path="/assets" element={<AssetsPage />} />',
      '<Route path="/risk-templates" element={<RiskTemplatesPage />} />',
      '<Route path="/executions" element={<ExecutionsPage />} />',
      '<Route path="/executions/:executionId" element={<ExecutionDetailPage />} />',
      '<Route path="/settings" element={<SettingsPage />} />',
    ]) {
      expect(`${route}:${app.includes(route)}`).toBe(`${route}:true`);
    }
  });

  it("keeps the trading-control route clear of the executions prefix", () => {
    // A path like /executions/trading-control would be swallowed by the
    // :executionId route and render an execution detail page instead.
    const item = NAV_ITEMS.find((entry) => entry.label === "Trading Control");
    expect(item?.to.startsWith("/executions")).toBe(false);
  });
});

describe("trading control page: the card moved, it was not rebuilt", () => {
  it("mounts the existing card on the dedicated page", () => {
    const page = src("pages/TradingControlPage.tsx");
    expect(page).toContain('import { TradingControlCard } from "../components/operator/TradingControlCard";');
    expect(page).toContain("<TradingControlCard />");
  });

  it("no longer mounts the card on the Dashboard", () => {
    const dashboard = src("pages/DashboardPage.tsx");
    expect(dashboard).not.toContain("TradingControlCard");
    expect(dashboard).not.toContain("operator/");
  });

  it("leaves the Dashboard's own monitoring sections in place", () => {
    // The move must not have taken anything else with it.
    const dashboard = src("pages/DashboardPage.tsx");
    for (const section of ["<OutcomeSummary />", "<TradeDisciplineSummary />", "<AlertFilters", "<AlertFeed"]) {
      expect(`${section}:${dashboard.includes(section)}`).toBe(`${section}:true`);
    }
  });

  it("duplicates none of the card's logic on the page", () => {
    // The page is a heading and a mount. Any session, polling or safety
    // vocabulary appearing here would mean a second implementation had started.
    const page = src("pages/TradingControlPage.tsx");
    for (const forbidden of [
      "useTradingControl",
      "operatorAuthHeaders",
      "setOperatorToken",
      "fetchTradingControlStatus",
      "fetchTradingControlReadiness",
      "setInterval",
      "SAFE_OFF",
      "LOCKED_ACTIONS",
    ]) {
      expect(`${forbidden}:${page.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it("changes nothing inside the card, the hook, the session or the presentation", () => {
    // The behaviour this move must not disturb: token entry, in-memory-only
    // storage, the auth probe, the state model, 15s polling, the explicit
    // readiness check and the disabled actions all still live where they did.
    const card = src("components/operator/TradingControlCard.tsx");
    const hook = src("hooks/useTradingControl.ts");
    for (const expected of ["useTradingControl", "checkReadiness", "LOCKED_ACTIONS", "presentReadinessSnapshot"]) {
      expect(`card:${expected}:${card.includes(expected)}`).toBe(`card:${expected}:true`);
    }
    for (const expected of ["setInterval", "fetchTradingControlStatus", "fetchTradingControlReadiness", "endSession"]) {
      expect(`hook:${expected}:${hook.includes(expected)}`).toBe(`hook:${expected}:true`);
    }
    // Still no persistence, anywhere on the moved path.
    for (const forbidden of ["localStorage", "sessionStorage", "document.cookie"]) {
      expect(`${forbidden}:${(card + hook).includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

describe("trading control page: layout follows the existing convention", () => {
  const page = src("pages/TradingControlPage.tsx");

  it("uses the same heading treatment as the other pages", () => {
    // Matches ExecutionsPage / SettingsPage rather than introducing a second
    // page-header style.
    expect(page).toContain('<h1 className="text-lg font-semibold text-slate-100">Trading Control</h1>');
    expect(page).toContain('className="text-sm text-slate-400"');
  });

  it("does not enlarge the card", () => {
    // Constrained like Settings: this is a focused operator surface, not a wide
    // monitoring view, and the card itself is unchanged.
    expect(page).toContain("max-w-2xl");
  });
});
