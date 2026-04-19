// Runtime configuration stub.
//
// In production this file is overwritten at container start by
// `deploy/web.entrypoint.sh` with values from the ARGUS_API_URL /
// ARGUS_WS_URL env vars. In dev (`pnpm dev`) it ships as-is — empty
// strings keep `host.ts` on its hostname-derivation fallback, which
// is the right behaviour for a dev server reachable on the LAN.
//
// Do not import this file from anywhere; it sets a window global by
// design so it can be loaded before the React bundle (and before any
// `import.meta.env.VITE_*` reference is evaluated).
window.__ARGUS_CONFIG__ = { apiUrl: '', wsUrl: '' };
