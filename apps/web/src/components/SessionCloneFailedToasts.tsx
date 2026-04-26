import { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useCloneFailureStore } from '../stores/cloneFailureStore';

/**
 * Bottom-right toast stack for failed session-clone-from-turn attempts.
 * Mirrors SidecarUpdateToasts in placement and styling so a clone
 * failure landing concurrently with a sidecar update reads as one
 * stack rather than two competing layers. Auto-dismisses after 8s
 * (failure copy is short, not actionable beyond "next prompt starts
 * fresh", so leaving it sticky would just be visual debt).
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

  if (visible.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {visible.map((f) => (
        <div
          key={f.sessionId}
          className="pointer-events-auto rounded-lg border border-amber-500/40 bg-neutral-950 px-3 py-2.5 shadow-lg shadow-black/40"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[12px] font-medium text-neutral-100">
                <span className="truncate">{f.sessionTitle}</span>
                <span className="ml-auto text-[10px] font-normal text-neutral-500">
                  clone failed
                </span>
              </div>
              <div className="mt-0.5 text-[11px] text-neutral-400">
                Couldn't fork CLI state. Next prompt will start a fresh conversation.
              </div>
              {f.reason && (
                <div className="mt-1 truncate text-[10px] text-neutral-600" title={f.reason}>
                  {f.reason}
                </div>
              )}
            </div>
            <button
              onClick={() => dismiss(f.sessionId)}
              className="shrink-0 text-neutral-600 hover:text-neutral-200"
              title="dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
