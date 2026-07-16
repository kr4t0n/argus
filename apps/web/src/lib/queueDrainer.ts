import { useEffect } from 'react';
import { api } from './api';
import { useQueueStore } from '../stores/queueStore';
import { useSessionStore } from '../stores/sessionStore';
import { useMachineStore } from '../stores/machineStore';
import { useProjectStore } from '../stores/projectStore';
import { resolveProjectRef } from './projects';

/**
 * Background prompt-queue drainer.
 *
 * The per-session queue (see queueStore / PromptQueue) used to drain only
 * while its session was open in `SessionPanel`. This hook lifts that into
 * a single app-wide loop so queued prompts keep sending no matter which
 * session — if any — the user is currently looking at.
 *
 * How it knows when to send, given two laggy signals:
 *   • `agent.status` (online/busy/offline) is heartbeat-reported every 5s,
 *     so it's too slow to drive turn-to-turn pacing.
 *   • `session.status` ('active' while a turn streams, 'idle'/'failed'
 *     when it finishes) is event-driven off result chunks AND broadcast to
 *     the whole `user:{id}` room — so `sessionStore.sessions[id].status`
 *     stays fresh for EVERY session, open or not. That's our pacing clock.
 *
 * Serialization is per SESSION, not per agent. Each turn spawns its own
 * short-lived CLI process (`claude --resume <session-external-id>`), and
 * the sidecar dispatches them as independent goroutines with no per-agent
 * lock — so sessions that share an agent run truly in parallel. The only
 * thing we must NOT do is run two turns for the SAME session at once: they
 * would both resume the same id off the pre-turn transcript and corrupt it
 * (and break the queue's FIFO "each prompt builds on the last" intent). So
 * a session is gated only on its OWN state:
 *   • `session.status === 'active'` → it's mid-turn, wait.
 *   • an `inFlight` entry for it → we've dispatched but the turn hasn't
 *     shown up as `active` yet (bridges the dispatch→first-chunk window);
 *     cleared once it goes active or after a timeout.
 * Reachability (skip while the target is down) is MACHINE-level since
 * the runner refactor: liveness belongs to the sidecar process, and
 * runner sidecars send no per-agent signal at all. The machine is
 * resolved through the session's pinned project (agent row fallback
 * for workdir-less sessions); only when no machine is resolvable do we
 * fall back to the legacy agent-status check. Skipping (rather than
 * letting the server reject) matters: a rejected send re-queues the
 * head under a 60s stall cooldown, so an offline blip would delay the
 * queue far longer than the outage itself.
 */

/** Safety valve: drop an in-flight guard if a dispatched turn never shows
 *  up as `active` (lost event / stuck agent). Comfortably past the
 *  dispatch→first-chunk gap and the 5s heartbeat. */
const INFLIGHT_TIMEOUT_MS = 30_000;
/** After a failed send, hold that head back this long before retrying, so
 *  a hard error can't hot-loop while still self-healing transient ones. */
const STALL_COOLDOWN_MS = 60_000;
/** Coalesce bursts of store changes (esp. streaming chunk appends) into a
 *  single drain pass. */
const DRAIN_DEBOUNCE_MS = 120;

export function useQueueDrainer() {
  useEffect(() => {
    // sessionId → ts we dispatched a turn but haven't yet seen it go active.
    const inFlight = new Map<string, number>();
    // sessionId → { head id whose send failed, ts to retry after }.
    const stalled = new Map<string, { headId: string; until: number }>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    function schedule() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        drain();
      }, DRAIN_DEBOUNCE_MS);
    }

    function drain() {
      const now = Date.now();
      const { queues } = useQueueStore.getState();
      const sessionIds = Object.keys(queues);
      if (sessionIds.length === 0) return;

      const { sessions } = useSessionStore.getState();
      const { machines } = useMachineStore.getState();
      const { projects } = useProjectStore.getState();

      // Release in-flight guards whose turn has started (now visible as
      // `active` — the status gate takes over) or that timed out.
      for (const [sid, ts] of [...inFlight]) {
        if (sessions[sid]?.status === 'active' || now - ts > INFLIGHT_TIMEOUT_MS) {
          inFlight.delete(sid);
        }
      }

      for (const sessionId of sessionIds) {
        const queue = queues[sessionId];
        if (!queue || queue.length === 0) continue;
        const session = sessions[sessionId];
        if (!session) continue; // not loaded yet / deleted — leave queued
        // Reachability is machine-level: resolve the session's project →
        // machine and gate on the machine being online. When the project
        // rows haven't hydrated yet, hold the queue rather than draining
        // against an unknown machine.
        const machineId = resolveProjectRef(session, projects)?.machineId;
        if (!machineId) continue; // machine not resolvable yet — leave queued
        if (machines[machineId]?.status !== 'online') continue; // machine down
        // Serialize per SESSION only: a session can't run two turns at once
        // (they'd both `--resume` the same id and corrupt its transcript).
        // We gate on THIS session's state, never any sibling session's.
        if (session.status === 'active') continue; // this session mid-turn
        if (inFlight.has(sessionId)) continue; // dispatch in flight for it

        const head = queue[0];
        const hold = stalled.get(sessionId);
        if (hold && (hold.headId !== head.id || now > hold.until)) {
          stalled.delete(sessionId); // head changed or cooldown elapsed
        } else if (hold) {
          continue; // still held back after a recent failure
        }

        // Mark the session in-flight BEFORE awaiting so neither the rest of
        // this loop nor a re-entrant drain double-dispatches to it.
        inFlight.set(sessionId, now);
        const item = useQueueStore.getState().dequeueHead(sessionId);
        if (!item) {
          inFlight.delete(sessionId);
          continue;
        }
        void (async () => {
          try {
            const cmd = await api.sendCommand(sessionId, {
              prompt: item.prompt,
              attachmentIds: item.attachments.length
                ? item.attachments.map((a) => a.id)
                : undefined,
            });
            // Instant feedback for a session the user happens to have open;
            // others reconcile via the normal WS command/chunk stream.
            if (useSessionStore.getState().entries[sessionId]) {
              useSessionStore.getState().upsertCommand(cmd);
            }
            // Keep the in-flight guard set — it clears once the turn shows
            // up as active (or times out), serializing the next item.
          } catch {
            // Restore the prompt and hold it back briefly so a hard error
            // (e.g. a rejected attachment, or the agent just went offline)
            // can't spin; the cooldown lets transient failures retry.
            useQueueStore.getState().enqueueFront(sessionId, item);
            stalled.set(sessionId, { headId: item.id, until: now + STALL_COOLDOWN_MS });
            inFlight.delete(sessionId);
          }
          schedule(); // re-evaluate after the dispatch settles
        })();
      }
    }

    const unsubscribes = [
      useQueueStore.subscribe(schedule),
      useSessionStore.subscribe(schedule),
      useMachineStore.subscribe(schedule),
      useProjectStore.subscribe(schedule),
    ];
    schedule(); // initial pass — picks up persisted queues on load

    return () => {
      unsubscribes.forEach((u) => u());
      if (timer) clearTimeout(timer);
    };
  }, []);
}
