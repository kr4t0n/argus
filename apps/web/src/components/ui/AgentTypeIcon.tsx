import { Bot, Code2, Terminal, Sparkles } from 'lucide-react';
import { cn } from '../../lib/utils';

type Props = {
  type: string;
  className?: string;
};

const map: Record<string, { Icon: typeof Bot; color: string; label: string }> = {
  'claude-code': { Icon: Sparkles, color: 'text-agent-claude-code', label: 'Claude Code' },
  codex: { Icon: Code2, color: 'text-agent-codex', label: 'Codex' },
  'cursor-cli': { Icon: Terminal, color: 'text-agent-cursor-cli', label: 'Cursor CLI' },
};

export function AgentTypeIcon({ type, className }: Props) {
  const hit = map[type];
  const Icon = hit?.Icon ?? Bot;
  const color = hit?.color ?? 'text-agent-custom';
  return <Icon className={cn('h-3.5 w-3.5', color, className)} />;
}

export function agentTypeLabel(type: string): string {
  return map[type]?.label ?? type;
}
