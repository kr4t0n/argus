import { Monitor, Moon, Sun } from 'lucide-react';
import { useUIStore, type ThemePreference } from '../stores/uiStore';

/**
 * Three-state theme toggle in the sidebar header.
 *
 * Cycles light → dark → system → light on click. The icon shows the
 * CURRENT preference (not the resolved theme) so the user can tell at
 * a glance whether they're on auto. Tooltip names the next state so
 * the cycle is discoverable without ambiguity.
 *
 * Sizing matches the surrounding header buttons (h-3.5 w-3.5 icons).
 */
const NEXT: Record<ThemePreference, ThemePreference> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

const ICON: Record<ThemePreference, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

const LABEL: Record<ThemePreference, string> = {
  light: 'light',
  dark: 'dark',
  system: 'system',
};

export function ThemeToggle() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const Icon = ICON[theme];
  const next = NEXT[theme];
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className="text-fg-tertiary hover:text-fg-primary transition-colors"
      title={`theme: ${LABEL[theme]} — click for ${LABEL[next]}`}
      aria-label={`theme: ${LABEL[theme]}, click to switch to ${LABEL[next]}`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}
