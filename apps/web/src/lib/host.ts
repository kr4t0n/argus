// Resolve the absolute base URL for HTTP and WebSocket calls to the NestJS
// server. Three sources, in priority order:
//
//   1. RUNTIME — `window.__ARGUS_CONFIG__` injected by `/config.js`. The
//      docker image's entrypoint generates that file from container env
//      vars (`ARGUS_API_URL`, `ARGUS_WS_URL`), so the same image can be
//      retargeted across environments without a rebuild.
//
//   2. BUILD-TIME — `import.meta.env.VITE_API_URL` baked into the bundle
//      at `vite build`. Useful when you want a fully self-contained
//      image with no entrypoint script (or when running `pnpm dev` with
//      a dotenv override).
//
//   3. RUNTIME-DERIVED — fall back to `<window.location.protocol>//
//      <window.location.hostname>:4000`. This keeps a dev build served
//      on the LAN (e.g. `http://192.168.1.10:5173` from a phone) usable
//      without any config: the API is assumed to live on the same host
//      at port 4000. Anything that hard-codes `localhost` here will
//      silently break for any client that isn't the dev machine — that
//      was the "load failed" bug we hit when signing in from a phone.

const DEFAULT_API_PORT = 4000;

declare global {
  interface Window {
    __ARGUS_CONFIG__?: {
      apiUrl?: string;
      wsUrl?: string;
    };
  }
}

function resolve(runtime: string | undefined, buildTime: string | undefined): string {
  if (runtime && runtime.length > 0) return runtime;
  if (buildTime && buildTime.length > 0) return buildTime;
  if (typeof window === 'undefined') return `http://localhost:${DEFAULT_API_PORT}`;
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:${DEFAULT_API_PORT}`;
}

function runtimeConfig(): Window['__ARGUS_CONFIG__'] {
  if (typeof window === 'undefined') return undefined;
  return window.__ARGUS_CONFIG__;
}

export function apiBaseUrl(): string {
  return resolve(runtimeConfig()?.apiUrl, import.meta.env.VITE_API_URL as string | undefined);
}

export function wsBaseUrl(): string {
  return resolve(runtimeConfig()?.wsUrl, import.meta.env.VITE_WS_URL as string | undefined);
}
