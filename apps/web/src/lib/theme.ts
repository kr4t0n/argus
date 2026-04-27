/**
 * Theme effect — keeps the `dark` class on <html> in sync with the
 * user's persisted choice and the OS `prefers-color-scheme`.
 *
 * Wiring:
 *   - `theme` lives in uiStore (persisted via localStorage).
 *   - `useApplyTheme()` subscribes to that field AND to OS-level
 *     prefers-color-scheme changes; resolves 'system' → 'light'|'dark'
 *     and toggles the class.
 *   - `applyThemeImmediate()` runs once at module load before React
 *     hydrates, so the very first paint matches the saved theme
 *     (no flash of wrong-theme content / FOWTC).
 *
 * The CSS variable layer in index.css does the rest — every component
 * already speaks the semantic-token vocabulary (bg-surface-0, etc.),
 * so flipping `dark` on <html> swaps the entire palette in one paint.
 */
import { useEffect } from 'react';
import { useUIStore, type ThemePreference } from '../stores/uiStore';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Resolve a preference to a concrete theme using the browser's
 *  current OS color scheme. Pure / non-side-effecting. */
export function resolveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref;
  // SSR-safe: fall back to 'dark' when window isn't available.
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/** Apply (or remove) the `dark` class on <html> based on a resolved
 *  value. Idempotent. */
function setRootDark(isDark: boolean) {
  const root = document.documentElement;
  if (isDark) root.classList.add('dark');
  else root.classList.remove('dark');
}

/**
 * Run as early as possible (in main.tsx, before React mounts) so the
 * very first paint already has the right theme. Reads zustand-persist
 * directly from localStorage to avoid a render-cycle round trip.
 */
export function applyThemeImmediate() {
  let pref: ThemePreference = 'system';
  try {
    const raw = localStorage.getItem('argus.ui');
    if (raw) {
      const parsed = JSON.parse(raw);
      const t = parsed?.state?.theme;
      if (t === 'light' || t === 'dark' || t === 'system') {
        pref = t;
      }
    }
  } catch {
    // Storage unavailable / malformed — fall through to 'system'.
  }
  setRootDark(resolveTheme(pref) === 'dark');
}

/**
 * Hook: keeps <html>'s `dark` class in sync with the store and (when
 * preference is 'system') with the OS color-scheme media query. Mount
 * once at the app shell; idempotent — re-runs are cheap.
 */
export function useApplyTheme() {
  const theme = useUIStore((s) => s.theme);

  useEffect(() => {
    setRootDark(resolveTheme(theme) === 'dark');

    // Only listen to OS changes when the user opted into 'system'.
    // Listening unconditionally would force a class flip on every OS
    // toggle even when the user explicitly chose light or dark.
    if (theme !== 'system') return;
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mq = window.matchMedia(DARK_QUERY);
    const handler = () => setRootDark(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);
}
