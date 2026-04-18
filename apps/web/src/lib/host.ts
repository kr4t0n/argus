// Resolve the absolute base URL for HTTP and WebSocket calls to the NestJS
// server. We prefer the explicit env override so production builds can hit a
// fixed URL, but fall back to deriving the host from `window.location` so a
// dev build served on the LAN (e.g. `http://192.168.1.10:5173` from a phone)
// reaches the API at `http://192.168.1.10:4000` instead of trying to call
// the phone's own `localhost`.
//
// Anything that hard-codes `http://localhost:4000` will silently break for
// any client that isn't the dev machine — that was the "load failed" we
// hit when signing in from a phone.

const DEFAULT_API_PORT = 4000;

function fromWindow(envURL: string | undefined): string {
  if (envURL && envURL.length > 0) return envURL;
  if (typeof window === 'undefined') return `http://localhost:${DEFAULT_API_PORT}`;
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${DEFAULT_API_PORT}`;
}

export function apiBaseUrl(): string {
  return fromWindow(import.meta.env.VITE_API_URL as string | undefined);
}

export function wsBaseUrl(): string {
  return fromWindow(import.meta.env.VITE_WS_URL as string | undefined);
}
