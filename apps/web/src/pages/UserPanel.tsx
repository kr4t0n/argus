import { ReactNode, useCallback, useEffect, useState } from 'react';
import { Check, Loader2, User } from 'lucide-react';
import type {
  TokenUsage,
  UserActivityResponse,
  UserUsageResponse,
} from '@argus/shared-types';
import { USER_RULES_MAX_BYTES, hasUsage } from '@argus/shared-types';
import { ApiError, api } from '../lib/api';
import { cn } from '../lib/utils';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import { ActivityHeatmap } from '../components/ActivityHeatmap';
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
                {!activityError && activity && <ActivityHeatmap days={activity.days} />}
              </Subsection>
              <Subsection title="Usage">
                {usageError && (
                  <div className="text-sm text-red-500 dark:text-red-400">{usageError}</div>
                )}
                {!usageError && !usage && <UsageLedgerSkeleton />}
                {!usageError && usage && <UsageLedger usage={usage.usage} />}
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

            {/* Trailing room so the last Group can scroll up to the
                top of the viewport when its anchor is clicked. */}
            <div aria-hidden className="h-[90vh]" />
          </div>
        </div>
      </div>
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

function UsageLedger({ usage }: { usage: TokenUsage }) {
  if (!hasUsage(usage)) {
    return (
      <div className="text-meta">
        No completed turns yet. Usage appears once an agent finishes a prompt.
      </div>
    );
  }
  const formatTokens = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}k`
        : n.toLocaleString();

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

function formatApiDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)} m`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)} h`;
}
