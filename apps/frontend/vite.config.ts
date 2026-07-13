import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load VITE_* env vars (.env, .env.local, .env.[mode]) so the dev server can
  // be told which extra hostnames to accept — e.g. a private Tailscale Serve
  // hostname — without hardcoding it. Vite always allows localhost and IP
  // addresses on its own; this list only ADDS explicit extra hosts.
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const allowedHosts = (env.VITE_DEV_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);

  return {
    plugins: [react()],
    server: {
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
        "/api": { target: "http://127.0.0.1:4000", changeOrigin: true },
        "/socket.io": { target: "http://127.0.0.1:4000", changeOrigin: true, ws: true },
        "/screenshots": { target: "http://127.0.0.1:4000", changeOrigin: true },
      },
    },
  };
});
