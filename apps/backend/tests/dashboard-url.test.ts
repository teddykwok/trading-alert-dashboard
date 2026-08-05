import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Resolver unit tests. The env module is mocked so every configuration shape
 * — including a genuinely MISSING value — can be exercised without depending
 * on the developer's local .env (dotenv would otherwise leak it in).
 */
async function loadWith(publicDashboardUrl: string | undefined) {
  vi.resetModules();
  vi.doMock("../src/config/env", () => ({ env: { PUBLIC_DASHBOARD_URL: publicDashboardUrl } }));
  return import("../src/utils/dashboard-url");
}

afterEach(() => {
  vi.doUnmock("../src/config/env");
  vi.resetModules();
});

describe("publicDashboardBaseUrl", () => {
  it("returns null when the value is missing entirely", async () => {
    const { publicDashboardBaseUrl, publicAlertUrl } = await loadWith(undefined);
    expect(publicDashboardBaseUrl()).toBeNull();
    expect(publicAlertUrl("alert_1")).toBeNull();
  });

  it("returns null for empty and whitespace-only values", async () => {
    for (const value of ["", "   ", "\t\n"]) {
      const { publicDashboardBaseUrl } = await loadWith(value);
      expect(publicDashboardBaseUrl()).toBeNull();
    }
  });

  it("returns null for loopback hosts", async () => {
    for (const value of [
      "http://localhost:5173",
      "https://localhost",
      "http://app.localhost:5173",
      "http://127.0.0.1:5173",
      "http://127.10.0.5",
      "http://0.0.0.0:5173",
      "http://[::1]:5173",
    ]) {
      const { publicDashboardBaseUrl } = await loadWith(value);
      expect(publicDashboardBaseUrl(), value).toBeNull();
    }
  });

  it("returns null for values that are not absolute URLs", async () => {
    for (const value of ["my-dashboard", "/alerts", "localhost:5173"]) {
      const { publicDashboardBaseUrl } = await loadWith(value);
      expect(publicDashboardBaseUrl(), value).toBeNull();
    }
  });

  it("keeps real public URLs and normalizes trailing slashes", async () => {
    const cases: Array<[string, string]> = [
      ["https://dash.example.com", "https://dash.example.com"],
      ["https://dash.example.com/", "https://dash.example.com"],
      ["https://dash.example.com///", "https://dash.example.com"],
      ["https://dash.example.com/app/", "https://dash.example.com/app"],
    ];
    for (const [configured, expected] of cases) {
      const { publicDashboardBaseUrl, publicAlertUrl } = await loadWith(configured);
      expect(publicDashboardBaseUrl()).toBe(expected);
      expect(publicAlertUrl("alert_1")).toBe(`${expected}/alerts/alert_1`);
    }
  });

  it("treats LAN and tailnet hosts as public (nothing is auto-detected)", async () => {
    for (const value of ["http://192.168.1.50:5173", "https://my-host.tailnet.ts.net"]) {
      const { publicDashboardBaseUrl } = await loadWith(value);
      expect(publicDashboardBaseUrl(), value).toBe(value);
    }
  });
});
