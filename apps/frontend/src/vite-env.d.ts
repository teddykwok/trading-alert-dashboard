/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Optional overrides. When empty/unset the app uses same-origin requests
  // (see api/client.ts and sockets/socket.ts).
  readonly VITE_API_URL?: string;
  readonly VITE_SOCKET_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
