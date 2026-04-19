import { Bot } from 'lucide-react';
import { ClaudeCode, Codex, Cursor } from '@lobehub/icons';
import { cn } from '../../lib/utils';

type Props = {
  type: string;
  className?: string;
  /** pixel size; defaults to 14 (matches the old `h-3.5 w-3.5` lucide sizing). */
  size?: number;
};

type Entry = {
  Icon: React.ComponentType<{
    size?: number | string;
    className?: string;
    style?: React.CSSProperties;
  }>;
  label: string;
  /**
   * The lobehub `.Color` brand icons paint their own fill, so we must NOT slap a
   * `text-agent-*` class on them — currentColor would override the brand stroke.
   * Mono icons use `currentColor` though, so they inherit whatever text color the
   * row already has (looks correct on our dark sidebar).
   */
  inheritColor: boolean;
};

const map: Record<string, Entry> = {
  'claude-code': { Icon: ClaudeCode.Color, label: 'Claude Code', inheritColor: false },
  // Codex's `.Color` variant is a black glyph on a white square — fine on a
  // light page, but it pops as a white chip on our dark UI. Use the mono
  // glyph instead so it inherits surrounding text color, like Cursor.
  codex: { Icon: Codex, label: 'Codex', inheritColor: true },
  'cursor-cli': { Icon: Cursor, label: 'Cursor CLI', inheritColor: true },
};

export function AgentTypeIcon({ type, className, size = 14 }: Props) {
  const hit = map[type];
  if (!hit) {
    return <Bot className={cn('h-3.5 w-3.5 text-agent-custom', className)} />;
  }
  const { Icon, inheritColor } = hit;
  return (
    <Icon
      size={size}
      className={cn('shrink-0', inheritColor && 'text-neutral-200', className)}
    />
  );
}

export function agentTypeLabel(type: string): string {
  return map[type]?.label ?? type;
}
