import { ReactNode, useCallback, useEffect, useState } from 'react';
import { Check, Loader2, User } from 'lucide-react';
import type {
  ActivityDay,
  QuotaWindow,
  TokenUsage,
  UserActivityResponse,
  UserQuotaResponse,
  UserQuotaRow,
  UserUsageResponse,
  WindowedUsage,
} from '@argus/shared-types';
import { USER_RULES_MAX_BYTES, hasUsage } from '@argus/shared-types';
import { ApiError, api } from '../lib/api';
import { cn } from '../lib/utils';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
import { ActivityLineChart } from '../components/ActivityLineChart';
import { Button } from '../components/ui/Button';
import { requestNotificationPermission } from '../lib/notifications';

export function UserPanel() {
  const user = useAuthStore((s) => s.user);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);

  const [activity, setActivity] = useState<UserActivityResponse | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);

  const [usage, setUsage] = useState<UserUsageResponse | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  const [quota, setQuota] = useState<UserQuotaResponse | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);

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
    api
      .getMyQuota()
      .then((d) => {
        if (!cancelled) setQuota(d);
      })
      .catch((err) => {
        if (cancelled) return;
        setQuotaError(err instanceof ApiError ? err.message : 'failed to load quota');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto w-full max-w-6xl shrink-0 px-10 pt-14 pb-10">
        {!sidebarOpen && (
          <button
            onClick={toggleSidebar}
            className="md:hidden mb-6 text-fg-tertiary hover:text-fg-primary"
            title="show sidebar"
          >
            <User className="h-4 w-4" />
          </button>
        )}
        <header>
          <h1 className="truncate text-base font-medium text-fg-primary">
            {user?.email ?? 'you'}
          </h1>
          {user?.role && (
            <p className="mt-0.5 text-xs text-fg-tertiary">{user.role}</p>
          )}
        </header>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar scroll-smooth">
        <div className="mx-auto flex max-w-6xl gap-12 px-10 pb-10">
          <nav className="sticky top-2 hidden h-fit w-32 shrink-0 self-start md:block">
            <ul className="space-y-3">
              <li>
                <a
                  href="#stats"
                  className="block text-sm text-fg-secondary transition-colors hover:text-fg-primary"
                >
                  Stats
                </a>
              </li>
              <li>
                <a
                  href="#preferences"
                  className="block text-sm text-fg-secondary transition-colors hover:text-fg-primary"
                >
                  Preferences
                </a>
              </li>
              <li>
                <a
                  href="#extensions"
                  className="block text-sm text-fg-secondary transition-colors hover:text-fg-primary"
                >
                  Extensions
                </a>
              </li>
            </ul>
          </nav>

          <div className="min-w-0 flex-1">
            <Group id="stats" title="Stats">
              <Subsection title="Activity">
                {activityError && (
                  <div className="text-sm text-red-500 dark:text-red-400">{activityError}</div>
                )}
                {!activityError && !activity && (
                  <div className="flex items-center gap-2 text-sm text-fg-tertiary">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading…
                  </div>
                )}
                {!activityError && activity && <ActivityView days={activity.days} />}
              </Subsection>
              <Subsection title="Usage">
                {usageError && (
                  <div className="text-sm text-red-500 dark:text-red-400">{usageError}</div>
                )}
                {!usageError && !usage && <UsageLedgerSkeleton />}
                {!usageError && usage && <UsageSection usage={usage.usage} />}
              </Subsection>
              <Subsection title="Quota">
                {quotaError && (
                  <div className="text-sm text-red-500 dark:text-red-400">{quotaError}</div>
                )}
                {!quotaError && !quota && <QuotaListSkeleton />}
                {!quotaError && quota && <QuotaList quotas={quota.quotas} />}
              </Subsection>
            </Group>

            <Group id="preferences" title="Preferences">
              <Row
                title="Desktop notifications"
                description="When a task finishes outside the session you're currently viewing, Argus shows a desktop notification and plays a chime. Click the notification to jump to that session."
                control={<NotificationToggle />}
              />
              <Row
                title="Agent rules"
                description={
                  <>
                    Free-form guidance every CLI agent you spawn should follow — coding
                    style, banned patterns, project conventions. On Save, Argus pushes
                    the text to every online sidecar, which writes{' '}
                    <code className="font-mono text-fg-secondary">
                      ~/.claude/CLAUDE.md
                    </code>{' '}
                    for Claude Code and{' '}
                    <code className="font-mono text-fg-secondary">
                      ~/.codex/AGENTS.md
                    </code>{' '}
                    for Codex on each host.
                  </>
                }
              >
                <RulesEditor />
              </Row>
            </Group>

            <Group id="extensions" title="Extensions">
              <Row
                title="Notes"
                description="Adds a Note tab beside Terminal in each session's right panel — a free-form scratchpad scoped to the project (every session sharing the same working directory sees the same note). Notes are saved to your account, so they follow you across browsers and devices."
                control={<NotesExtensionToggle />}
              />
              <Row
                title="Progress"
                description={
                  <>
                    Adds a Progress tab to the session right panel that lists live background tasks
                    running in the project. Wrap any long-running command with{' '}
                    <code className="font-mono text-[12px]">argus-bg -- &lt;command&gt;</code> and
                    its tqdm-style progress shows up here in real time, even after you background it
                    with <code className="font-mono text-[12px]">&amp;</code>.
                  </>
                }
                control={<ProgressExtensionToggle />}
              />
              <Row
                title="Diff"
                description="Adds a Diff tab to the session right panel showing every file the agent changed in the most recent turn, as a per-file diff. Updates live as the turn edits files."
                control={<DiffExtensionToggle />}
              />
            </Group>

            {/* Trailing room so the last Group can scroll up to the
                top of the viewport when its anchor is clicked. */}
            <div aria-hidden className="h-[90vh]" />
          </div>
        </div>
      </div>
    </div>
  );
}

type ActivityViewMode = 'grid' | 'line';

const ACTIVITY_VIEWS: ReadonlyArray<{ id: ActivityViewMode; label: string }> = [
  { id: 'grid', label: 'Grid' },
  { id: 'line', label: 'Curve' },
];

/** Same activity payload, two readings: the GitHub-style heatmap grid
 *  and a by-day commands curve. The toggle just swaps the view — no
 *  refetch. Defaults to the grid to preserve the prior behavior. */
function ActivityView({ days }: { days: ActivityDay[] }) {
  const [view, setView] = useState<ActivityViewMode>('grid');
  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label="activity view"
        className="inline-flex self-start rounded-md bg-surface-1 p-0.5"
      >
        {ACTIVITY_VIEWS.map((v) => {
          const active = v.id === view;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setView(v.id)}
              className={cn(
                'rounded-[5px] px-3 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-surface-2 text-fg-primary'
                  : 'text-fg-tertiary hover:text-fg-secondary',
              )}
            >
              {v.label}
            </button>
          );
        })}
      </div>
      {view === 'grid' ? (
        <ActivityHeatmap days={days} />
      ) : (
        <ActivityLineChart days={days} />
      )}
    </div>
  );
}

function Group({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mt-20 first:mt-0 scroll-mt-10">
      <h2 className="font-display text-3xl font-semibold tracking-tight text-fg-primary">{title}</h2>
      <div className="mt-8 space-y-14">{children}</div>
    </section>
  );
}

function Subsection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-5 text-base font-semibold tracking-tight text-fg-primary">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Row({
  title,
  description,
  control,
  children,
}: {
  title: string;
  description: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-8">
        <div className="min-w-0 max-w-xl">
          <div className="text-sm font-medium text-fg-primary">{title}</div>
          <p className="mt-1 text-xs leading-relaxed text-fg-tertiary">{description}</p>
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

function NotificationToggle() {
  const enabled = useUIStore((s) => s.notificationsEnabled);
  const setEnabled = useUIStore((s) => s.setNotificationsEnabled);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onToggle = useCallback(async () => {
    setError(null);
    if (enabled) {
      setEnabled(false);
      return;
    }
    setBusy(true);
    try {
      const result = await requestNotificationPermission();
      if (result === 'granted') {
        setEnabled(true);
      } else if (result === 'denied') {
        setError(
          'Notifications are blocked in your browser. Re-allow them in site settings to enable.',
        );
      } else if (result === 'unsupported') {
        setError('This browser does not support desktop notifications.');
      } else {
        setError('Permission prompt dismissed — click again to re-prompt.');
      }
    } finally {
      setBusy(false);
    }
  }, [enabled, setEnabled]);

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        onClick={onToggle}
        disabled={busy}
        size="sm"
        variant={enabled ? 'subtle' : 'default'}
      >
        {busy ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" /> requesting…
          </>
        ) : enabled ? (
          'Disable'
        ) : (
          'Enable'
        )}
      </Button>
      {error && (
        <p className="max-w-xs text-right text-xs text-red-500 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

function NotesExtensionToggle() {
  const enabled = useUIStore((s) => s.notesExtensionEnabled);
  const setEnabled = useUIStore((s) => s.setNotesExtensionEnabled);
  const progressEnabled = useUIStore((s) => s.progressExtensionEnabled);
  const diffEnabled = useUIStore((s) => s.diffExtensionEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The flag is account-level (synced across browsers), so persist it
  // server-side. Flip the local cache optimistically for an instant
  // response, then revert if the PUT fails. Each toggle PUTs the full
  // known set — the server has no merge semantics, so we forward every
  // other extension's current state alongside our change.
  const onToggle = useCallback(async () => {
    const next = !enabled;
    setError(null);
    setEnabled(next);
    setBusy(true);
    try {
      await api.setMyExtensions({ notes: next, progress: progressEnabled, diff: diffEnabled });
    } catch (err) {
      setEnabled(!next);
      setError(err instanceof ApiError ? err.message : 'failed to save');
    } finally {
      setBusy(false);
    }
  }, [enabled, setEnabled, progressEnabled, diffEnabled]);

  return (
    <div className="flex flex-col items-end gap-2">
      <Button onClick={onToggle} disabled={busy} size="sm" variant={enabled ? 'subtle' : 'default'}>
        {busy ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" /> saving…
          </>
        ) : enabled ? (
          'Disable'
        ) : (
          'Enable'
        )}
      </Button>
      {error && (
        <p className="max-w-xs text-right text-xs text-red-500 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

function ProgressExtensionToggle() {
  const enabled = useUIStore((s) => s.progressExtensionEnabled);
  const setEnabled = useUIStore((s) => s.setProgressExtensionEnabled);
  const notesEnabled = useUIStore((s) => s.notesExtensionEnabled);
  const diffEnabled = useUIStore((s) => s.diffExtensionEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onToggle = useCallback(async () => {
    const next = !enabled;
    setError(null);
    setEnabled(next);
    setBusy(true);
    try {
      await api.setMyExtensions({ notes: notesEnabled, progress: next, diff: diffEnabled });
    } catch (err) {
      setEnabled(!next);
      setError(err instanceof ApiError ? err.message : 'failed to save');
    } finally {
      setBusy(false);
    }
  }, [enabled, setEnabled, notesEnabled, diffEnabled]);

  return (
    <div className="flex flex-col items-end gap-2">
      <Button onClick={onToggle} disabled={busy} size="sm" variant={enabled ? 'subtle' : 'default'}>
        {busy ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" /> saving…
          </>
        ) : enabled ? (
          'Disable'
        ) : (
          'Enable'
        )}
      </Button>
      {error && (
        <p className="max-w-xs text-right text-xs text-red-500 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

function DiffExtensionToggle() {
  const enabled = useUIStore((s) => s.diffExtensionEnabled);
  const setEnabled = useUIStore((s) => s.setDiffExtensionEnabled);
  const notesEnabled = useUIStore((s) => s.notesExtensionEnabled);
  const progressEnabled = useUIStore((s) => s.progressExtensionEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onToggle = useCallback(async () => {
    const next = !enabled;
    setError(null);
    setEnabled(next);
    setBusy(true);
    try {
      await api.setMyExtensions({ notes: notesEnabled, progress: progressEnabled, diff: next });
    } catch (err) {
      setEnabled(!next);
      setError(err instanceof ApiError ? err.message : 'failed to save');
    } finally {
      setBusy(false);
    }
  }, [enabled, setEnabled, notesEnabled, progressEnabled]);

  return (
    <div className="flex flex-col items-end gap-2">
      <Button onClick={onToggle} disabled={busy} size="sm" variant={enabled ? 'subtle' : 'default'}>
        {busy ? (
          <>
            <Loader2 className="h-3 w-3 animate-spin" /> saving…
          </>
        ) : enabled ? (
          'Disable'
        ) : (
          'Enable'
        )}
      </Button>
      {error && (
        <p className="max-w-xs text-right text-xs text-red-500 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

function RulesEditor() {
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
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
  // Server enforces a byte limit (UTF-8). The user-facing counter
  // shows characters because that's what people read; the overlimit
  // check stays byte-based so non-ASCII rules can't sneak past.
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

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-fg-tertiary">
        <Loader2 className="h-3 w-3 animate-spin" /> loading…
      </div>
    );
  }

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        spellCheck={false}
        placeholder="e.g. Prefer pure functions. No console.log in committed code. Match existing import order."
        className="block w-full resize-y rounded-md bg-surface-1/60 px-4 py-3.5 font-sans text-sm leading-6 text-fg-primary outline-none placeholder:text-fg-muted transition-colors focus:bg-surface-1"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span
          className={cn(
            'font-mono text-[11px] tabular-nums',
            overLimit ? 'text-red-500 dark:text-red-400' : 'text-fg-muted',
          )}
          title={`${byteCount.toLocaleString()} bytes used of ${USER_RULES_MAX_BYTES.toLocaleString()} byte limit`}
        >
          {text.length.toLocaleString()} / {USER_RULES_MAX_BYTES.toLocaleString()} chars
        </span>
        <div className="flex items-center gap-3 text-xs">
          {error && <span className="text-red-500 dark:text-red-400">{error}</span>}
          {!error && justSaved && (
            <span className="inline-flex items-center gap-1 text-emerald-500 dark:text-emerald-400">
              <Check className="h-3 w-3" /> saved
            </span>
          )}
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
      </div>
    </div>
  );
}

type UsageWindow = '7d' | '30d' | 'all';

const USAGE_WINDOWS: ReadonlyArray<{ id: UsageWindow; label: string }> = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All time' },
];

/** One payload, three windows — the toggle just selects which slice of
 *  `WindowedUsage` the ledger renders; no refetch. Defaults to 30 days
 *  because that's the most actionable "what am I spending lately" view;
 *  "All time" preserves the pre-windows behavior for anyone who wants
 *  the lifetime headline. */
function UsageSection({ usage }: { usage: WindowedUsage }) {
  const [window, setWindow] = useState<UsageWindow>('30d');
  const current =
    window === '7d' ? usage.last7Days : window === '30d' ? usage.last30Days : usage.lifetime;
  const emptyHint =
    window === 'all'
      ? 'No completed turns yet. Usage appears once an agent finishes a prompt.'
      : `No usage in the last ${window === '7d' ? '7' : '30'} days.`;
  return (
    <div>
      <div className="mb-6">
        <UsageWindowToggle value={window} onChange={setWindow} />
      </div>
      <UsageLedger usage={current} emptyHint={emptyHint} />
    </div>
  );
}

function UsageWindowToggle({
  value,
  onChange,
}: {
  value: UsageWindow;
  onChange: (w: UsageWindow) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="usage time window"
      className="inline-flex rounded-md bg-surface-1 p-0.5"
    >
      {USAGE_WINDOWS.map((w) => {
        const active = w.id === value;
        return (
          <button
            key={w.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(w.id)}
            className={cn(
              'rounded-[5px] px-3 py-1 text-xs font-medium transition-colors',
              active
                ? 'bg-surface-2 text-fg-primary'
                : 'text-fg-tertiary hover:text-fg-secondary',
            )}
          >
            {w.label}
          </button>
        );
      })}
    </div>
  );
}

function UsageLedger({ usage, emptyHint }: { usage: TokenUsage; emptyHint?: string }) {
  if (!hasUsage(usage)) {
    return (
      <div className="text-meta">
        {emptyHint ?? 'No completed turns yet. Usage appears once an agent finishes a prompt.'}
      </div>
    );
  }
  const formatTokens = (n: number) => {
    const units: Array<{ value: number; suffix: string }> = [
      { value: 1e15, suffix: 'Q' },
      { value: 1e12, suffix: 'T' },
      { value: 1e9, suffix: 'B' },
      { value: 1e6, suffix: 'M' },
      { value: 1e3, suffix: 'k' },
    ];
    for (const { value, suffix } of units) {
      if (n >= value) return `${(n / value).toFixed(1)}${suffix}`;
    }
    return n.toLocaleString();
  };

  const entries: Array<{
    label: string;
    value: string;
    muted: boolean;
    tone?: 'cost';
  }> = [
    { label: 'Input', value: formatTokens(usage.inputTokens), muted: usage.inputTokens === 0 },
    {
      label: 'Output',
      value: formatTokens(usage.outputTokens),
      muted: usage.outputTokens === 0,
    },
    {
      label: 'Cache read',
      value: formatTokens(usage.cacheReadTokens),
      muted: usage.cacheReadTokens === 0,
    },
    {
      label: 'Cache write',
      value: formatTokens(usage.cacheWriteTokens),
      muted: usage.cacheWriteTokens === 0,
    },
  ];
  if (usage.costUsd !== undefined) {
    entries.push({
      label: 'Cost',
      value: `$${usage.costUsd.toFixed(2)}`,
      muted: usage.costUsd === 0,
      tone: 'cost',
    });
  }
  if (usage.durationApiMs !== undefined) {
    entries.push({
      label: 'API time',
      value: formatApiDuration(usage.durationApiMs),
      muted: usage.durationApiMs === 0,
    });
  }

  return (
    <dl className="flex flex-wrap gap-x-12 gap-y-7">
      {entries.map((e) => (
        <div key={e.label} className="min-w-[6rem]">
          <dt className="text-caps">{e.label}</dt>
          <dd
            className={cn(
              'mt-1.5 font-display text-2xl font-semibold tabular-nums tracking-tight',
              e.muted
                ? 'text-fg-tertiary'
                : e.tone === 'cost'
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-fg-primary',
            )}
          >
            {e.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function UsageLedgerSkeleton() {
  return (
    <dl
      className="flex flex-wrap gap-x-12 gap-y-7"
      role="status"
      aria-label="loading usage"
    >
      {['Input', 'Output', 'Cache read', 'Cache write', 'Cost', 'API time'].map((label) => (
        <div key={label} className="min-w-[6rem]">
          <dt className="text-caps">{label}</dt>
          <dd className="mt-1.5 h-8 w-24 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </dl>
  );
}

function QuotaList({ quotas }: { quotas: UserQuotaRow[] }) {
  if (quotas.length === 0) {
    return (
      <div className="text-meta">
        No quota data yet. Sign in to <code className="font-mono">claude</code> or{' '}
        <code className="font-mono">codex</code> on a host running an Argus sidecar; the next
        heartbeat (~5 min) will fetch your remaining plan windows.
      </div>
    );
  }
  return (
    <div className="space-y-8">
      {quotas.map((q) => (
        <QuotaRow key={`${q.type}:${q.machineId}`} row={q} />
      ))}
    </div>
  );
}

function QuotaRow({ row }: { row: UserQuotaRow }) {
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold tracking-tight text-fg-primary">
            {labelForAgentType(row.type)}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-fg-tertiary" title={row.machineName}>
            via {row.machineName} · checked {timeAgo(row.checkedAt)}
          </div>
        </div>
      </div>
      {row.error && row.windows.length === 0 && (
        <div
          className="rounded-md border border-amber-300/50 bg-amber-50/50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-900/20 dark:text-amber-300"
          title={row.error}
        >
          Couldn't read quota: {row.error}
        </div>
      )}
      {row.windows.length > 0 && (
        <dl className="space-y-3">
          {row.windows.map((w) => (
            <QuotaBar key={w.key} window={w} />
          ))}
        </dl>
      )}
    </div>
  );
}

function QuotaBar({ window: w }: { window: QuotaWindow }) {
  const used = Math.max(0, Math.min(100, w.utilizationPercent));
  // Color the bar by how close we are to running out — same thresholds
  // (60%/85%) as Anthropic's own /status display, picked because <60%
  // reads as "fine", 60–85% as "be aware", >85% as "you might hit the
  // wall this window."
  const tone =
    used >= 85
      ? 'bg-red-500 dark:bg-red-400'
      : used >= 60
        ? 'bg-amber-500 dark:bg-amber-400'
        : 'bg-emerald-500 dark:bg-emerald-400';
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-xs text-fg-secondary">{w.label}</dt>
        <dd className="font-mono text-[11px] tabular-nums text-fg-tertiary">
          {used}% used
          {w.resetsAt && (
            <span className="text-fg-muted"> · resets {formatResetAt(w.resetsAt)}</span>
          )}
        </dd>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn('h-full rounded-full transition-all', tone)}
          style={{ width: `${used}%` }}
        />
      </div>
    </div>
  );
}

function QuotaListSkeleton() {
  return (
    <div className="space-y-8" role="status" aria-label="loading quota">
      {[0, 1].map((i) => (
        <div key={i}>
          <div className="mb-3 h-4 w-32 animate-pulse rounded bg-surface-2" />
          <div className="space-y-3">
            <div className="h-1.5 w-full animate-pulse rounded-full bg-surface-2" />
            <div className="h-1.5 w-full animate-pulse rounded-full bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function labelForAgentType(t: string): string {
  switch (t) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'cursor-cli':
      return 'Cursor CLI';
    default:
      return t;
  }
}

function formatResetAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const minutes = diffMs / 60_000;
  if (minutes < 60) return `in ${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `in ${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  const days = hours / 24;
  return `in ${days.toFixed(days < 10 ? 1 : 0)}d`;
}

function timeAgo(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return 'just now';
  const minutes = diffMs / 60_000;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h ago`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)}d ago`;
}

function formatApiDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)} m`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)} h`;
}
