import { env } from "../config/env";

/**
 * Loopback hosts only. A LAN address (192.168.x, a Tailscale host, …) is a
 * perfectly good "public" dashboard for a phone on the same network, so it is
 * deliberately NOT treated as local — only addresses that can never resolve
 * from another device are.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\./.test(host)
  );
}

/**
 * Base URL for links shared OUTSIDE the app (Telegram). PUBLIC_DASHBOARD_URL
 * is optional: when it is unset, empty, unparseable, or points at a loopback
 * address, this returns null and callers omit the link entirely rather than
 * sending a URL that cannot be opened from a phone.
 *
 * Nothing is auto-detected or guessed — the value comes only from
 * configuration. Trailing slashes are normalized away.
 */
export function publicDashboardBaseUrl(): string | null {
  // `?? ""` keeps this safe even if the value is absent entirely (the schema
  // already defaults a missing key to an empty string).
  const configured = (env.PUBLIC_DASHBOARD_URL ?? "").trim();
  if (!configured) return null;

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return null; // not an absolute URL — unusable as a shared link
  }

  // Require an explicit http(s) origin: "localhost:5173" (a missing-scheme
  // typo) otherwise parses as scheme "localhost:" with an empty hostname and
  // would sneak past the loopback check as a broken link.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;

  if (isLoopbackHost(parsed.hostname)) return null;

  return configured.replace(/\/+$/, "");
}

/** `${PUBLIC_DASHBOARD_URL}/alerts/{alertId}`, or null when no public URL is configured. */
export function publicAlertUrl(alertId: string): string | null {
  const base = publicDashboardBaseUrl();
  return base === null ? null : `${base}/alerts/${alertId}`;
}
