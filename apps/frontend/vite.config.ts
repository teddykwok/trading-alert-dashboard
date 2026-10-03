import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load VITE_* env vars (.env, .env.local, .env.[mode]) so the dev server can
  // be told which extra hostnames to accept — e.g. a private Tailscale Serve
  // hostname — without hardcoding it. Vite always allows localhost and IP
  // addresses on its own; this list only ADDS explicit extra hosts.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  // Operator control is NOT configured here any more. The ONE frontend names
  // the target account in every operator request (/api/operator/accounts/A/...
  // or /api/operator/accounts/B/...), which reaches the generic backend under
  // "/api" below; its account gateway forwards to exactly that account's
  // loopback-only control plane from a fixed server-side allowlist. The browser
  // never learns a control-plane port and no build is specific to one account.

  const allowedHosts = (env.VITE_DEV_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

  return {
    plugins: [react()],
    server: {
      // Bind IPv4 loopback explicitly. Without this Vite listens on "localhost",
      // which on IPv6-first machines resolves to ::1 and binds IPv6 ONLY — then
      // Tailscale Serve / Test-NetConnection (which target 127.0.0.1) get a
      // connection refused (502). 127.0.0.1 stays loopback-only (no LAN
      // exposure; remote access is via Tailscale Serve) and is deterministic
      // regardless of a machine's localhost resolution order.
      host: "127.0.0.1",
      port: 5173,
      // Exit instead of silently falling back to 5174 when 5173 is taken, so
      // Tailscale Serve (which proxies to localhost:5173) never points at the
      // wrong port.
      strictPort: true,
      // Explicit allow-list (never `true`). localhost/IP access is still
      // permitted by Vite regardless of this list.
      allowedHosts,
      // Same-origin proxy so the browser only ever talks to this dev-server
      // origin (e.g. the Tailscale hostname) and never needs to reach the
      // backend on localhost:4000 directly — on a remote machine "localhost"
      // would be that machine, not the backend host. The backend serves these
      // exact prefixes; none are rewritten:
      //   /api/*        -> Fastify routes
      //   /socket.io/*  -> Socket.IO (default path; ws:true for the upgrade)
      //   /screenshots/*-> Fastify static (used by ScreenshotPreview)
      proxy: {
        // Every /api request -- account-scoped operator requests included --
        // goes to the generic backend. There is deliberately no per-account
        // proxy entry and no control-plane URL in the browser's configuration.
        "/api": { target: "http://127.0.0.1:4000", changeOrigin: true },
        "/socket.io": { target: "http://127.0.0.1:4000", changeOrigin: true, ws: true },
        "/screenshots": { target: "http://127.0.0.1:4000", changeOrigin: true },
      },
    },
  };
});
