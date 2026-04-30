// Desktop-notification + completion-sound plumbing for "task done"
// signals. All of this is intentionally framework-agnostic (no React /
// router imports) so it can be called both from the WS handler in
// App.tsx and from the toggle in UserPanel without coupling them.
//
// The decision matrix lives in the caller (`shouldNotifyForTransition`):
// we only fire when the just-completed session is NOT the active route
// OR the tab is hidden — i.e., whenever the user can't visibly see the
// completion in-app. The fire-time path also re-checks the live OS
// permission state on every call so a user who revoked permission in
// browser settings silently no-ops without us trying to re-prompt
// (re-prompting requires a user gesture anyway).

/** Pull the active session id out of the URL. Mirrors the
 *  `/sessions/:sessionId` route shape declared in `App.tsx`. Returns
 *  null on any non-session route (`/`, `/user`, `/machines/:id`, …),
 *  which is the correct "no active session" answer for suppression. */
export function activeSessionIdFromPath(pathname: string): string | null {
  const m = /^\/sessions\/([^/]+)/.exec(pathname);
  return m ? m[1] : null;
}

/** Decide whether a command-status transition should fire a
 *  notification. Pulls the "session not active OR tab hidden" rule
 *  out of the WS handler so the policy is testable in isolation.
 *  `prevStatus` and `nextStatus` are the command's status before and
 *  after the just-arrived event; we fire only on a true running →
 *  completed/failed transition (not on idempotent re-deliveries of
 *  the same final state, which Redis at-least-once can produce). */
export function shouldNotifyForTransition(args: {
  prevStatus: string | undefined;
  nextStatus: string;
  sessionId: string;
  activeSessionId: string | null;
  tabVisible: boolean;
}): boolean {
  const { prevStatus, nextStatus, sessionId, activeSessionId, tabVisible } = args;
  const wasRunning =
    prevStatus !== undefined && ['pending', 'sent', 'running'].includes(prevStatus);
  const isDone = nextStatus === 'completed' || nextStatus === 'failed';
  if (!wasRunning || !isDone) return false;
  // Suppress only when the user can plausibly see the completion: tab
  // visible AND viewing this session. Any other combination — tab
  // hidden, on a different session, on /user, etc. — earns a notify.
  if (tabVisible && activeSessionId === sessionId) return false;
  return true;
}

/** Synthesized two-tone ping using Web Audio. No bundled asset to ship,
 *  works offline, and the descending interval for failure is
 *  immediately distinguishable from the ascending success interval
 *  even at low volume. Best-effort: throws are swallowed because
 *  audio playback can be blocked by autoplay policy on browsers that
 *  haven't yet seen a user gesture (uncommon on a logged-in dashboard
 *  but not impossible). The AudioContext is closed shortly after the
 *  beep so we don't leak audio threads on repeated fires. */
export function playDoneSound(success: boolean): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const now = ctx.currentTime;
    // C5 → G5 ascending for success; A4 → E4 descending for failure.
    const freqs = success ? [523.25, 783.99] : [440, 329.63];
    for (let i = 0; i < freqs.length; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freqs[i];
      const start = now + i * 0.13;
      // Quick attack, exponential decay — feels like a chime, not a beep.
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.22);
    }
    // Give the last note time to decay, then release the audio thread.
    window.setTimeout(() => {
      void ctx.close();
    }, 700);
  } catch {
    /* audio unavailable — silent failure is fine */
  }
}

/** State machine for the "enable notifications" toggle's permission
 *  request. We expose the four possible UX outcomes so the caller
 *  (UserPanel) can render the right inline message and decide whether
 *  to actually flip the toggle on. */
export type PermissionResult =
  | 'granted'
  | 'denied'
  | 'unsupported'
  /** User dismissed the prompt without choosing — Chrome returns
   *  `default` in that case. Treated as "not enabled", but distinct
   *  from `denied` because we CAN re-prompt later. */
  | 'dismissed';

/** Ask the browser for notification permission. MUST be called from a
 *  user-gesture handler (click) — browsers reject `requestPermission()`
 *  outside of one. Idempotent when permission is already granted /
 *  denied so the caller can call this unconditionally on toggle-on. */
export async function requestNotificationPermission(): Promise<PermissionResult> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') return 'granted';
    if (result === 'denied') return 'denied';
    return 'dismissed';
  } catch {
    return 'unsupported';
  }
}

interface CompletionParams {
  sessionId: string;
  sessionTitle: string;
  success: boolean;
  /** Called when the user clicks the OS notification. Should focus the
   *  tab and route to the session. Receiving the routing function
   *  (instead of doing window.location.href ourselves) keeps the
   *  notification module decoupled from react-router and lets the
   *  caller skip the navigation if they prefer (we don't, today). */
  onClick: () => void;
}

/** Show the OS notification for a finished command. No-ops when
 *  notifications aren't supported, permission isn't granted, or the
 *  Notification constructor throws (some environments — service-worker-
 *  only origins, embedded WebViews — restrict the page-level API).
 *  The `tag` is the session id so a second completion in the same
 *  session replaces (rather than stacks on) the first.  */
export function showCompletionNotification(p: CompletionParams): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  const verb = p.success ? 'completed' : 'failed';
  const prefix = p.success ? '✓' : '✗';
  try {
    const n = new Notification(`${prefix} ${p.sessionTitle}`, {
      body: `Argus task ${verb}`,
      tag: `argus-session-${p.sessionId}`,
      icon: '/favicon.svg',
    });
    n.onclick = () => {
      // Surface the tab first so the navigation lands on a focused
      // window — otherwise some browsers (Firefox) route correctly but
      // leave the tab in the background.
      window.focus();
      try {
        p.onClick();
      } finally {
        n.close();
      }
    };
  } catch {
    /* Notification ctor unavailable in this context — give up silently */
  }
}
