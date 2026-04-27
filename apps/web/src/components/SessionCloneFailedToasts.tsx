import { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useCloneFailureStore } from '../stores/cloneFailureStore';

/**
 * Failed session-clone-from-turn toast items. Returns a Fragment so the
 * toast host in `App.tsx` can interleave these with other toast types
 * in one shared bottom-right column. Auto-dismisses after 8s (failure
 * copy is short and not actionable beyond "next prompt starts fresh",
 * so leaving it sticky would just be visual debt).
 */
const AUTO_DISMISS_MS = 8_000;

export function SessionCloneFailedToasts() {
  const failures = useCloneFailureStore((s) => s.failures);
  const dismiss = useCloneFailureStore((s) => s.dismiss);

  const visible = Object.values(failures).sort((a, b) => b.startedAt - a.startedAt);

  useEffect(() => {
    const timers: number[] = [];
    for (const f of visible) {
      timers.push(window.setTimeout(() => dismiss(f.sessionId), AUTO_DISMISS_MS));
    }
    return () => timers.forEach(window.clearTimeout);
  }, [visible, dismiss]);

  return (
    <>
      {visible.map((f) => (
        <div
          key={f.sessionId}
          className="pointer-events-auto rounded-lg border border-amber-500/40 bg-surface-0 px-3 py-2.5 shadow-lg shadow-black/40"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[12px] font-medium text-fg-primary">
                <span className="truncate">{f.sessionTitle}</span>
                <span className="ml-auto text-[10px] font-normal text-fg-tertiary">
                  clone failed
                </span>
              </div>
              <div className="mt-0.5 text-[11px] text-fg-tertiary">
                Couldn't fork CLI state. Next prompt will start a fresh conversation.
              </div>
              {f.reason && (
                <div className="mt-1 truncate text-[10px] text-fg-muted" title={f.reason}>
                  {f.reason}
                </div>
              )}
            </div>
            <button
              onClick={() => dismiss(f.sessionId)}
              className="shrink-0 text-fg-muted hover:text-fg-primary"
              title="dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
