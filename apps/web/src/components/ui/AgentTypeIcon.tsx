import { Bot } from 'lucide-react';
import { ClaudeCode, Codex, Cursor } from '@lobehub/icons';
import { cn } from '../../lib/utils';
import { useResolvedTheme } from '../../lib/theme';

type Props = {
  type: string;
  className?: string;
  /** pixel size; defaults to 14 (matches the old `h-3.5 w-3.5` lucide sizing). */
  size?: number;
};

type IconComponent = React.ComponentType<{
  size?: number | string;
  className?: string;
  style?: React.CSSProperties;
}>;

type Entry = {
  /** Icon component to render. May be theme-resolved at render time
   *  (e.g. Codex uses Color in light, mono in dark — see below). */
  Icon: IconComponent;
  label: string;
  /**
   * The lobehub `.Color` brand icons paint their own fill, so we must NOT slap a
   * `text-agent-*` class on them — currentColor would override the brand stroke.
   * Mono icons use `currentColor` though, so they inherit whatever text color the
   * row already has (looks correct on our dark sidebar).
   */
  inheritColor: boolean;
};

const STATIC: Record<string, Entry> = {
  'claude-code': { Icon: ClaudeCode.Color, label: 'Claude Code', inheritColor: false },
  'cursor-cli': { Icon: Cursor, label: 'Cursor CLI', inheritColor: true },
};

const LABELS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(STATIC).map(([k, v]) => [k, v.label])),
  codex: 'Codex',
};

/**
 * Resolve the codex icon for the active theme.
 *
 * Codex's `.Color` brand glyph is a black mark on a white tile —
 * looks correct on the light page but pops as a bright white chip on
 * the dark surface. Inversely, the mono glyph picks up currentColor
 * which is light-on-dark in dark theme but reads as a flat dark
 * stroke on the light page (no brand affordance). So we pick:
 *
 *   light → Codex.Color (brand mark on white)
 *   dark  → Codex (mono, inherits surrounding text color)
 */
function codexEntry(theme: 'light' | 'dark'): Entry {
  if (theme === 'light') {
    return { Icon: Codex.Color, label: 'Codex', inheritColor: false };
  }
  return { Icon: Codex, label: 'Codex', inheritColor: true };
}

export function AgentTypeIcon({ type, className, size = 14 }: Props) {
  const theme = useResolvedTheme();
  const hit = type === 'codex' ? codexEntry(theme) : STATIC[type];
  if (!hit) {
    return <Bot className={cn('h-3.5 w-3.5 text-agent-custom', className)} />;
  }
  const { Icon, inheritColor } = hit;
  return (
    <Icon size={size} className={cn('shrink-0', inheritColor && 'text-fg-primary', className)} />
  );
}

export function agentTypeLabel(type: string): string {
  return LABELS[type] ?? type;
}
