import { io, type Socket } from "socket.io-client";

// An explicit VITE_SOCKET_URL overrides everything. When empty/unset we connect
// to the current browser origin, so through Tailscale Serve the connection
// becomes wss://<tailscale-host>/socket.io/… (proxied by Vite to the backend).
// No localhost fallback. The default Socket.IO path ("/socket.io") matches the
// backend, so it is left implicit.
const configuredSocketUrl = import.meta.env.VITE_SOCKET_URL?.trim();
const SOCKET_URL = configuredSocketUrl || window.location.origin;

let socket: Socket | null = null;

/**
 * Lazily creates a single shared Socket.IO client connection for the app.
 * Reused by useSocketAlerts so we don't open a new connection per component.
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, { autoConnect: true, transports: ["websocket", "polling"] });
  }
  return socket;
}
