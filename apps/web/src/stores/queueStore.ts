import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * A lightweight, server-side reference to a file the user already
 * uploaded (status `done` in the Composer). We keep only what the queue
 * needs — the id to re-attach on send, plus name/mime for a chip — and
 * deliberately drop the object-URL thumbnail: object URLs don't survive
 * a reload, so persisting them would render broken images.
 */
export interface QueuedAttachment {
  id: string;
  name: string;
  mime: string;
}

export interface QueuedPrompt {
  /** Stable client-side id for keying, editing and removal. */
  id: string;
  prompt: string;
  attachments: QueuedAttachment[];
}

interface QueueState {
  /** sessionId → ordered list of prompts waiting to be sent (FIFO). */
  queues: Record<string, QueuedPrompt[]>;
  enqueue: (sessionId: string, prompt: string, attachments: QueuedAttachment[]) => void;
  /** Put an item back at the HEAD — used to restore a flush that failed. */
  enqueueFront: (sessionId: string, item: QueuedPrompt) => void;
  updatePrompt: (sessionId: string, id: string, prompt: string) => void;
  remove: (sessionId: string, id: string) => void;
  /** Remove and return the head, or `undefined` if the queue is empty. */
  dequeueHead: (sessionId: string) => QueuedPrompt | undefined;
  clear: (sessionId: string) => void;
}

let seq = 0;
/** `crypto.randomUUID` needs a secure context; fall back for plain-http
 *  self-hosted deploys. Uniqueness only matters within one session's
 *  queue, so a time+counter id is plenty. */
function genId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `q${Date.now()}_${++seq}`;
}

/** Write `next` for `sessionId`, dropping the key entirely when empty so
 *  the persisted map doesn't accumulate dead session entries forever. */
function withQueue(
  queues: Record<string, QueuedPrompt[]>,
  sessionId: string,
  next: QueuedPrompt[],
): Record<string, QueuedPrompt[]> {
  const copy = { ...queues };
  if (next.length === 0) delete copy[sessionId];
  else copy[sessionId] = next;
  return copy;
}

export const useQueueStore = create<QueueState>()(
  persist(
    (set, get) => ({
      queues: {},
      enqueue(sessionId, prompt, attachments) {
        const cur = get().queues[sessionId] ?? [];
        const item: QueuedPrompt = { id: genId(), prompt, attachments };
        set({ queues: withQueue(get().queues, sessionId, [...cur, item]) });
      },
      enqueueFront(sessionId, item) {
        const cur = get().queues[sessionId] ?? [];
        set({ queues: withQueue(get().queues, sessionId, [item, ...cur]) });
      },
      updatePrompt(sessionId, id, prompt) {
        const cur = get().queues[sessionId];
        if (!cur) return;
        const next = cur.map((q) => (q.id === id ? { ...q, prompt } : q));
        set({ queues: withQueue(get().queues, sessionId, next) });
      },
      remove(sessionId, id) {
        const cur = get().queues[sessionId];
        if (!cur) return;
        set({ queues: withQueue(get().queues, sessionId, cur.filter((q) => q.id !== id)) });
      },
      dequeueHead(sessionId) {
        const cur = get().queues[sessionId];
        if (!cur || cur.length === 0) return undefined;
        const [head, ...rest] = cur;
        set({ queues: withQueue(get().queues, sessionId, rest) });
        return head;
      },
      clear(sessionId) {
        set({ queues: withQueue(get().queues, sessionId, []) });
      },
    }),
    { name: 'argus.queue' },
  ),
);
