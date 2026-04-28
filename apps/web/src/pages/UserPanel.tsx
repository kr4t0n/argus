import { useEffect, useState } from 'react';
import { Loader2, User } from 'lucide-react';
import type { UserActivityResponse } from '@argus/shared-types';
import { ApiError, api } from '../lib/api';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import { ActivityHeatmap } from '../components/ActivityHeatmap';

/**
 * `/user` route. First iteration: a GitHub-style activity heatmap
 * over the last year of commands the user sent. Future panels
 * (per-day session digest, total token usage, recent agents) would
 * compose into the same column layout.
 */
export function UserPanel() {
  const user = useAuthStore((s) => s.user);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const [data, setData] = useState<UserActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .getMyActivity()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'failed to load activity');
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

        <section className="rounded-lg border border-default bg-surface-1 px-5 py-4">
          <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-widest text-fg-tertiary">
            Activity
          </h2>
          {error && <div className="text-[12px] text-red-400">{error}</div>}
          {!error && !data && (
            <div className="flex items-center gap-2 text-[12px] text-fg-tertiary">
              <Loader2 className="h-3 w-3 animate-spin" /> loading…
            </div>
          )}
          {!error && data && <ActivityHeatmap days={data.days} />}
        </section>
      </div>
    </div>
  );
}
