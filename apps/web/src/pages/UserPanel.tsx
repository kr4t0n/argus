import { useEffect, useState } from 'react';
import { Loader2, User } from 'lucide-react';
import type {
  TokenUsage,
  UserActivityResponse,
  UserUsageResponse,
} from '@argus/shared-types';
import { hasUsage } from '@argus/shared-types';
import { ApiError, api } from '../lib/api';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import { ActivityHeatmap } from '../components/ActivityHeatmap';

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

        <section className="rounded-lg border border-default bg-surface-1 px-5 py-4">
          <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-fg-tertiary">
            Total usage
          </h2>
          {usageError && <div className="text-[12px] text-red-400">{usageError}</div>}
          {!usageError && !usage && (
            <div className="flex items-center gap-2 text-[12px] text-fg-tertiary">
              <Loader2 className="h-3 w-3 animate-spin" /> loading…
            </div>
          )}
          {!usageError && usage && <UsageSummary usage={usage.usage} />}
        </section>
      </div>
    </div>
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
