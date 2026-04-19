/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Runtime configuration injected by /config.js (see apps/web/index.html
// and deploy/web.entrypoint.sh). The actual property reader lives in
// `lib/host.ts` — this is just the type declaration so TS/lint doesn't
// trip over `window.__ARGUS_CONFIG__`.
interface Window {
  __ARGUS_CONFIG__?: {
    apiUrl?: string;
    wsUrl?: string;
  };
}
