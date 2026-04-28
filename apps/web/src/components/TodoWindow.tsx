import { memo, useMemo, useState } from 'react';
import { ChevronDown, Circle, CircleCheck, ListTodo, LoaderCircle } from 'lucide-react';
import type { ResultChunkDTO } from '@argus/shared-types';
import { cn } from '../lib/utils';

type Props = {
  chunks: ResultChunkDTO[];
};

type TodoStatus = 'pending' | 'in_progress' | 'completed';

type Todo = {
  content: string;
  status: TodoStatus;
  /** Cursor / Claude both ship an `activeForm` for the in_progress
   *  variant ("Writing tests" vs "Write tests"); we prefer it when the
   *  todo is in flight so the panel reads as a live status line. */
  activeForm?: string;
};

/**
 * Persistent per-turn task tracker rendered under the activity pill.
 *
 * Sourced exclusively from the *latest* `TodoWrite`-style tool chunk in
 * the command's chunk list — each call replaces the full list, so we
 * never merge across calls. Open by default and stays open until the
 * user collapses it; we deliberately do NOT auto-collapse when every
 * todo completes, so the finished plan stays visible alongside the
 * assistant's answer.
 *
 * Returns null when:
 *   - no `TodoWrite` chunk exists in this turn (codex sessions, or any
 *     turn that simply didn't plan via todos), or
 *   - the latest todo payload has no parseable items.
 *
 * memo-wrapped: the chunks array reference is stabilised by the
 * StreamViewer group layer, so non-live turns won't re-render when a
 * chunk lands on the live one.
 */
export const TodoWindow = memo(function TodoWindow({ chunks }: Props) {
  const todos = useMemo(() => extractLatestTodos(chunks), [chunks]);

  const total = todos?.length ?? 0;
  const doneCount = useMemo(
    () => (todos ?? []).filter((t) => t.status === 'completed').length,
    [todos],
  );
  const allDone = total > 0 && doneCount === total;

  const [open, setOpen] = useState(true);

  if (!todos || total === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-default bg-surface-1/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-2 px-3.5 py-2 text-xs text-fg-tertiary transition-colors hover:bg-surface-2/40 hover:text-fg-primary"
      >
        <ListTodo className="h-3.5 w-3.5 shrink-0 text-fg-tertiary group-hover:text-fg-secondary" />
        <span className="text-fg-secondary">To-dos</span>
        <span className="tabular-nums text-fg-tertiary">
          {allDone ? total : `${doneCount}/${total}`}
        </span>
        <ChevronDown
          className={cn(
            'ml-auto h-3.5 w-3.5 shrink-0 text-fg-muted transition-transform group-hover:text-fg-tertiary',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <ul className="space-y-2.5 border-t border-default/80 px-3.5 py-3">
          {todos.map((t, i) => (
            <TodoRow key={i} todo={t} />
          ))}
        </ul>
      )}
    </div>
  );
});

function TodoRow({ todo }: { todo: Todo }) {
  const Icon =
    todo.status === 'completed'
      ? CircleCheck
      : todo.status === 'in_progress'
        ? LoaderCircle
        : Circle;

  // Prefer activeForm for in_progress so the row reads as "doing X" instead
  // of the imperative form. Falls back to content for pending/completed.
  const text =
    todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;

  return (
    <li className="flex items-start gap-2.5 text-xs leading-relaxed">
      <Icon
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          todo.status === 'completed' && 'text-emerald-500/80',
          todo.status === 'in_progress' && 'animate-spin text-fg-secondary',
          todo.status === 'pending' && 'text-fg-muted',
        )}
      />
      <span
        className={cn(
          'min-w-0 break-words',
          todo.status === 'completed' && 'text-fg-tertiary line-through',
          todo.status === 'in_progress' && 'text-fg-primary',
          todo.status === 'pending' && 'text-fg-secondary',
        )}
      >
        {text}
      </span>
    </li>
  );
}

/**
 * Walk the chunks in reverse and return the `todos` array from the most
 * recent `TodoWrite`-style tool chunk. Tool-name matching mirrors the
 * existing `describe()`/`iconFor()` lookups in `ToolPill.tsx` so we
 * stay aligned with how the rest of the UI identifies todo tools.
 *
 * Defensive on shape: TodoWrite input has been observed as
 *   { todos: [{ content, status, activeForm? }] }
 * across both Claude Code and Cursor CLI, but adapter-level stream-json
 * drift is a known gotcha (see AGENTS.md). We coerce per-field, drop
 * malformed rows, and clamp `status` to the three known values.
 */
function extractLatestTodos(chunks: ResultChunkDTO[]): Todo[] | null {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i];
    if (c.kind !== 'tool') continue;
    const meta = (c.meta ?? {}) as Record<string, unknown>;
    const name = typeof meta.tool === 'string' ? meta.tool.toLowerCase() : '';
    if (name !== 'todowrite' && name !== 'todo' && name !== 'task') continue;
    const input = (meta.input ?? {}) as Record<string, unknown>;
    const raw = input.todos;
    if (!Array.isArray(raw)) return null;
    const parsed: Todo[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const content = typeof row.content === 'string' ? row.content : '';
      if (!content) continue;
      const statusRaw = typeof row.status === 'string' ? row.status : 'pending';
      const status: TodoStatus =
        statusRaw === 'completed' || statusRaw === 'in_progress' ? statusRaw : 'pending';
      const activeForm =
        typeof row.activeForm === 'string' && row.activeForm ? row.activeForm : undefined;
      parsed.push({ content, status, activeForm });
    }
    return parsed.length > 0 ? parsed : null;
  }
  return null;
}
