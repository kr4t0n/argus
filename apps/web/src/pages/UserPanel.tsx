import { useCallback, useEffect, useState } from 'react';
import { Check, HelpCircle, Loader2, User } from 'lucide-react';
import type {
  TokenUsage,
  UserActivityResponse,
  UserUsageResponse,
} from '@argus/shared-types';
import { USER_RULES_MAX_BYTES, hasUsage } from '@argus/shared-types';
import { ApiError, api } from '../lib/api';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { Button } from '../components/ui/Button';
import { Tooltip } from '../components/ui/Tooltip';

/**
 * `/user` route. Two cards today:
 *   - Activity heatmap (commands per day, last year).
 *   - Total usage (lifetime token totals across every session,
 *     server-aggregated using the same parser the per-session
 *     UsageBadge uses).
 *
 * Each card has its own loading state — they fetch in parallel and
 * surface independently so a slow-to-aggregate usage scan doesn't
 * block the heatmap from rendering.
 */
export function UserPanel() {
  const user = useAuthStore((s) => s.user);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  const [activity, setActivity] = useState<UserActivityResponse | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);

  const [usage, setUsage] = useState<UserUsageResponse | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getMyActivity()
      .then((d) => {
        if (!cancelled) setActivity(d);
      })
      .catch((err) => {
        if (cancelled) return;
        setActivityError(err instanceof ApiError ? err.message : 'failed to load activity');
      });
    api
      .getMyUsage()
      .then((d) => {
        if (!cancelled) setUsage(d);
      })
      .catch((err) => {
        if (cancelled) return;
        setUsageError(err instanceof ApiError ? err.message : 'failed to load usage');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center gap-3">
          {!sidebarOpen && (
            <button
              onClick={toggleSidebar}
              className="md:hidden text-fg-tertiary hover:text-fg-primary"
              title="show sidebar"
            >
              <User className="h-4 w-4" />
            </button>
          )}
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-2 text-fg-secondary">
            <User className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg-primary truncate">
              {user?.email ?? 'You'}
            </div>
            <div className="text-[11px] text-fg-tertiary">{user?.role ?? ''}</div>
          </div>
        </div>

        <section className="mb-4 rounded-lg border border-default bg-surface-1 px-5 py-4">
          <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-fg-tertiary">
            Activity
          </h2>
          {activityError && <div className="text-[12px] text-red-400">{activityError}</div>}
          {!activityError && !activity && (
            <div className="flex items-center gap-2 text-[12px] text-fg-tertiary">
              <Loader2 className="h-3 w-3 animate-spin" /> loading…
            </div>
          )}
          {!activityError && activity && <ActivityHeatmap days={activity.days} />}
        </section>

        <section className="mb-4 rounded-lg border border-default bg-surface-1 px-5 py-4">
          <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-fg-tertiary">
            Total usage
          </h2>
          {usageError && <div className="text-[12px] text-red-400">{usageError}</div>}
          {!usageError && !usage && <UsageSummarySkeleton />}
          {!usageError && usage && <UsageSummary usage={usage.usage} />}
        </section>

        <section className="rounded-lg border border-default bg-surface-1 px-5 py-4">
          <RulesEditor />
        </section>
      </div>
    </div>
  );
}

/**
 * Editable rules card. Loads current value on mount, tracks a dirty
 * state against the last-saved baseline, and persists via PUT
 * /me/rules on Save. The Save button stays disabled until the user
 * actually changes something — covers the common "I navigated
 * here, looked at my rules, navigated away" path with no UX cost.
 *
 * Sidecar sync — propagating the saved value to the spawned agents'
 * AGENTS.md / CLAUDE.md / .cursorrules — is intentionally NOT in
 * this commit. Persistence first, sync later (the user explicitly
 * scoped it that way so the UI surface and the eventual
 * distribution mechanism can iterate independently).
 */
function RulesEditor() {
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Brief "Saved" affirmation that auto-fades — keeps the UI from
  // looking idle the moment a save resolves successfully.
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getMyRules()
      .then((d) => {
        if (cancelled) return;
        setText(d.rules);
        setSavedText(d.rules);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'failed to load rules');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = text !== savedText;
  const byteCount = new TextEncoder().encode(text).byteLength;
  const overLimit = byteCount > USER_RULES_MAX_BYTES;
  const canSave = dirty && !saving && !overLimit;

  const onSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      const resp = await api.setMyRules(text);
      setSavedText(resp.rules);
      setText(resp.rules);
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'failed to save rules');
    } finally {
      setSaving(false);
    }
  }, [canSave, text]);

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h2 className="text-[12px] font-semibold uppercase tracking-widest text-fg-tertiary">
            Rules
          </h2>
          <Tooltip
            side="right"
            content={
              <div className="max-w-[280px] text-[11px] leading-relaxed">
                Free-form guidance every CLI agent you spawn should follow — coding style,
                banned patterns, project conventions. On Save we push the text to every
                online sidecar, which writes{' '}
                <code className="font-mono">~/.claude/CLAUDE.md</code> for Claude Code and{' '}
                <code className="font-mono">~/.codex/AGENTS.md</code> for Codex on each
                host. Cursor CLI has no equivalent rules file yet.
              </div>
            }
          >
            <button
              type="button"
              aria-label="about rules"
              className="text-fg-muted hover:text-fg-secondary"
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
        <span
          className={
            'font-mono text-[10px] tabular-nums ' +
            (overLimit ? 'text-red-400' : 'text-fg-muted')
          }
          title="rules size in UTF-8 bytes / max"
        >
          {byteCount.toLocaleString()} / {USER_RULES_MAX_BYTES.toLocaleString()} bytes
        </span>
      </div>
      {loading && (
        <div className="flex items-center gap-2 text-[12px] text-fg-tertiary">
          <Loader2 className="h-3 w-3 animate-spin" /> loading…
        </div>
      )}
      {!loading && (
        <div className="relative">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder="e.g. Prefer pure functions. No console.log in committed code. Match existing import order."
            className="block w-full resize-y rounded-md border border-default bg-surface-0 px-3 py-2 font-mono text-[12px] leading-relaxed text-fg-primary outline-none placeholder:text-fg-muted focus:border-default-strong"
          />
          {/* Theme-matched resize glyph. The default WebKit ::-webkit-resizer
              is hidden globally (jarring white square on dark surfaces — see
              index.css) so we paint our own here: two short diagonals in
              fg-muted. `pointer-events-none` lets drags pass through to the
              textarea's underlying resize hit-area, so resizing still works. */}
          <svg
            aria-hidden
            className="pointer-events-none absolute bottom-1.5 right-1.5 h-2.5 w-2.5 text-fg-muted"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M2 10 L10 2" />
            <path d="M6 10 L10 6" />
          </svg>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-h-[18px] text-[11px]">
          {error && <span className="text-red-400">{error}</span>}
          {!error && justSaved && (
            <span className="inline-flex items-center gap-1 text-emerald-500 dark:text-emerald-400">
              <Check className="h-3 w-3" /> saved
            </span>
          )}
        </div>
        <Button onClick={onSave} disabled={!canSave} size="sm">
          {saving ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" /> saving…
            </>
          ) : (
            'Save'
          )}
        </Button>
      </div>
    </>
  );
}

/**
 * Lifetime usage breakdown card body. Shows the four core counters
 * plus optional cost / api-time rows when an adapter surfaces them.
 * Grid layout because tabular numerics on a single row scale poorly
 * with the cache lines (cache-read counts can dwarf raw input
 * tokens, e.g. 90 % of prompts hit the cache).
 */
function UsageSummary({ usage }: { usage: TokenUsage }) {
  if (!hasUsage(usage)) {
    return (
      <div className="text-[12px] text-fg-tertiary">
        No completed turns yet — usage shows up here once an agent finishes a prompt.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
      <Stat label="Input" value={usage.inputTokens} />
      <Stat label="Output" value={usage.outputTokens} />
      <Stat label="Cache read" value={usage.cacheReadTokens} muted={usage.cacheReadTokens === 0} />
      <Stat
        label="Cache write"
        value={usage.cacheWriteTokens}
        muted={usage.cacheWriteTokens === 0}
      />
      {usage.costUsd !== undefined && (
        <Stat
          label="Cost"
          value={`$${usage.costUsd.toFixed(2)}`}
          muted={usage.costUsd === 0}
        />
      )}
      {usage.durationApiMs !== undefined && (
        <Stat
          label="API time"
          value={formatApiDuration(usage.durationApiMs)}
          muted={usage.durationApiMs === 0}
        />
      )}
    </div>
  );
}

/**
 * Layout-matched placeholder for `UsageSummary`. Renders the same
 * 2/4-col grid with all six counters (input / output / cache read /
 * cache write / cost / api time) so the card occupies its real
 * height while the server-side aggregation runs — no jarring
 * expansion when the totals land. The bottom two are conditional in
 * the loaded view (claude-code surfaces them, codex/cursor don't);
 * for non-claude users the card shrinks slightly post-load, which is
 * still less jarring than the full-card expansion the spinner had.
 */
function UsageSummarySkeleton() {
  return (
    <div
      className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4"
      role="status"
      aria-label="loading usage"
    >
      {['Input', 'Output', 'Cache read', 'Cache write', 'Cost', 'API time'].map((label) => (
        <div key={label}>
          <div className="text-[10px] uppercase tracking-widest text-fg-muted">{label}</div>
          <div className="mt-1 h-[15px] w-16 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: number | string;
  muted?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-fg-muted">{label}</div>
      <div
        className={
          'mt-0.5 font-mono text-[15px] tabular-nums ' +
          (muted ? 'text-fg-tertiary' : 'text-fg-primary')
        }
      >
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

function formatApiDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)} m`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)} h`;
}
