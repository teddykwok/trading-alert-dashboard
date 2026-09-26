import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load VITE_* env vars (.env, .env.local, .env.[mode]) so the dev server can
  // be told which extra hostnames to accept — e.g. a private Tailscale Serve
  // hostname — without hardcoding it. Vite always allows localhost and IP
  // addresses on its own; this list only ADDS explicit extra hosts.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  // Where THIS dashboard sends operator control traffic. Deployment supplies
  // it; there is deliberately no default, because a guessed port would either
  // reach nothing or, worse, reach a different account's control plane. Unset
  // means operator requests fall through to the generic backend and 404 --
  // a loud, debuggable failure rather than a silent wrong target.
  const accountControlUrl = (env.VITE_ACCOUNT_CONTROL_URL ?? "").trim();

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
        // Phase 11F: LONGEST PREFIX FIRST. Vite matches proxy contexts in
        // declaration order (`for (const context in proxies)` with
        // `url.startsWith(context)`), so this entry must precede "/api" or the
        // generic backend would swallow operator traffic.
        //
        // Operator control moved to a per-account process that holds that
        // account's credentials; the generic backend no longer mounts those
        // routes. The browser is unaffected: it still makes same-origin
        // relative requests and still sends the operator token header.
        // VITE_ACCOUNT_CONTROL_URL selects WHICH account this dashboard
        // controls -- deployment configuration, never a request parameter.
        ...(accountControlUrl
          ? { "/api/operator": { target: accountControlUrl, changeOrigin: true } }
          : {}),
        "/api": { target: "http://127.0.0.1:4000", changeOrigin: true },
        "/socket.io": { target: "http://127.0.0.1:4000", changeOrigin: true, ws: true },
        "/screenshots": { target: "http://127.0.0.1:4000", changeOrigin: true },
      },
    },
  };
});
