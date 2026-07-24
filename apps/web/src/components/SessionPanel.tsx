import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Menu, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useMachineStore } from '../stores/machineStore';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { useFileTabsStore } from '../stores/fileTabsStore';
import { api } from '../lib/api';
import { joinSession, leaveSession } from '../lib/ws';
import { AgentTypeIcon } from './ui/AgentTypeIcon';
import { Button } from './ui/Button';
import { ResizeHandle } from './ui/ResizeHandle';
import { StreamViewer } from './StreamViewer';
import { Composer } from './Composer';
import { ContextPane } from './ContextPane';
import { FileTabStrip } from './FileTabStrip';
import { useProjectRef } from '../lib/projects';
import { useFileTabAutoRefresh } from '../lib/useFileTabAutoRefresh';
import { UsageBadge } from './UsageBadge';
import { relativeTime } from '../lib/utils';

// FileViewer pulls in shiki + grammars (~600 KB of WASM + per-grammar
// chunks). Lazy-load it so the main session page bundle stays lean —
// users that never preview a file never pay the cost.
const FileViewer = lazy(() =>
  import('./FileViewer').then((m) => ({ default: m.FileViewer })),
);

export function SessionPanel() {
  const { sessionId } = useParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entry = useSessionStore((s) => (sessionId ? s.entries[sessionId] : undefined));
  const loadSession = useSessionStore((s) => s.loadSession);
  const loadOlder = useSessionStore((s) => s.loadOlder);
  // Reachability is a property of the machine now (the Agent entity is
  // retired). Resolve the session's project, then its machine, and gate
  // the composer on the machine being offline — undefined (boot race /
  // workdir-less session) degrades to "enabled" since the server routes
  // by projectId regardless of what the client knows.
  const projectRef = useProjectRef(entry?.session);
  const machine = useMachineStore((s) =>
    projectRef ? s.machines[projectRef.machineId] : undefined,
  );
  const machineOffline = machine?.status === 'offline';
  // The queued follow-ups for this session are drained app-wide by
  // `useQueueDrainer` (see App.tsx), so they keep sending even when this
  // panel isn't open — no per-panel flush here anymore.

  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const contextPaneOpen = useUIStore((s) => s.contextPaneOpen);
  const toggleContextPane = useUIStore((s) => s.toggleContextPane);
  const contextPaneWidth = useUIStore((s) => s.contextPaneWidth);
  const setContextPaneWidth = useUIStore((s) => s.setContextPaneWidth);
  const contextPaneRef = useRef<HTMLDivElement | null>(null);
  // Drafts key by session now (they used to key by agent id).
  const draft = useUIStore((s) => (sessionId ? s.drafts[sessionId] ?? '' : ''));
  const setDraft = useUIStore((s) => s.setDraft);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);

    // We unsubscribe from the session room on navigation away, so any
    // chunks / command-updates that land for THIS session while the
    // user was viewing another one are missed by the WS layer. On
    // re-entry, force `loadSession` to refetch the tail window
    // instead of returning the (now-stale) cached entry — but only
    // when the cache still THINKS something is running. The
    // session:status handler keeps the list fresh, so by the time the
    // user navigates back the cached entry is usually already fresh
    // (running=false) and we can render instantly with no loading
    // flash. The local force-refetch is the fallback for the case
    // where the user re-enters before the status update landed (e.g.
    // machine offline).
    //
    // Why force-refetch and not a partial-seq backfill: the chunk
    // `seq` is per-command (each command's chunks restart at 1), but
    // the store's `lastSeq` is the global max across all chunks. A
    // newer command's seqs (1..N) are all <= that max, so a
    // `WHERE seq > lastSeq` filter would silently drop the new
    // command's chunks entirely — which made the activity pill
    // disappear in the first version of this fix.
    const cached = useSessionStore.getState().entries[sessionId];
    const cachedRunning =
      cached?.commands.some((c) => ['pending', 'sent', 'running'].includes(c.status)) ?? false;
    loadSession(sessionId, { force: !!cached?.loaded && cachedRunning })
      .catch((err) => setError(err.message ?? 'failed to load session'))
      .finally(() => setLoading(false));
    joinSession(sessionId);
    return () => {
      leaveSession(sessionId);
    };
  }, [sessionId, loadSession]);

  // `unread` is the terminal-result marker the result-ingestor sets when
  // a turn finishes (success or error); the sidebar surfaces it as a
  // green/red dot + bold title. As soon as the user is looking at the
  // session, clear it so the dot disappears — independent of the
  // `status` lifecycle value (a seen failure stops showing a dot but
  // stays lifecycle-`failed`). Two paths trigger this:
  //   1. Navigating into a session that was already unread.
  //   2. The active turn lands while the panel is mounted — the WS
  //      session:status event flips the cached entry to unread, this
  //      effect re-runs, and we clear it.
  // `markSeen` is a no-op once already seen, so fire-and-forget is safe.
  const unread = entry?.session.unread;
  useEffect(() => {
    if (!sessionId) return;
    if (!unread) return;
    void api.markSessionSeen(sessionId).catch(() => {
      /* silent — server-side is idempotent; a later WS event re-asserts */
    });
  }, [sessionId, unread]);

  const running = useMemo(() => {
    if (!entry) return false;
    return entry.commands.some((c) =>
      ['pending', 'sent', 'running'].includes(c.status),
    );
  }, [entry]);

  // Stable callback so <StreamViewer>'s useCallback/useEffect deps don't
  // churn on every parent render; the store closure already captures id.
  const onLoadOlder = useCallback(() => {
    if (sessionId) void loadOlder(sessionId);
  }, [sessionId, loadOlder]);

  // File tabs: filtered to the current project so the strip stays in
  // context. The active tab is "the chat" when nothing's selected OR
  // when the selection points to a different project's file (those tabs
  // are hidden but the store still remembers them, so navigating back
  // to the original project restores the selection).
  const openFiles = useFileTabsStore((s) => s.openFiles);
  const activeFileKey = useFileTabsStore((s) => s.activeKey);
  const activeFile = useMemo(() => {
    if (!projectRef || !activeFileKey) return null;
    return (
      openFiles.find((f) => f.key === activeFileKey && f.scope === projectRef.projectId) ?? null
    );
  }, [openFiles, activeFileKey, projectRef]);

  // Live file tabs: subscribe here rather than inside FileViewer, which
  // is mounted only for the focused tab and so could never mark a
  // background tab stale. Must sit above the `!sessionId` early return.
  useFileTabAutoRefresh(projectRef);

  if (!sessionId) {
    return (
      <div className="relative flex h-full items-center justify-center text-fg-tertiary text-sm">
        <button
          onClick={toggleSidebar}
          className="absolute left-4 top-3.5 md:hidden text-fg-tertiary hover:text-fg-primary transition-colors"
          title="show sidebar"
        >
          <Menu className="h-4 w-4" />
        </button>
        Select or start a session from the left.
      </div>
    );
  }

  // Loading placeholder fires in two cases:
  //  - First load (no entry yet) — same as before.
  //  - Re-entry where the cached state still thinks a turn is running
  //    (because the WS room was unsubscribed when the actual `final`
  //    chunk landed). Without this guard the activity pill would
  //    render the stale entry first, ticking elapsed = `now -
  //    startedAt` against a startedAt that's potentially minutes old,
  //    then snap back to the frozen value when the force-refetch
  //    resolves. The user sees a misleading "10 min → 1 min" jump.
  //    Showing loading until the refetch lands suppresses the jump in
  //    exchange for a brief (~one round trip) flash, which is the
  //    less surprising UX.
  if (loading && (!entry || running)) {
    return <div className="p-6 text-fg-tertiary text-sm">loading…</div>;
  }

  if (error) {
    return <div className="p-6 text-sm text-red-500 dark:text-red-400">{error}</div>;
  }

  if (!entry) return null;

  async function onSend(prompt: string, attachmentIds: string[]) {
    if (!sessionId) return;
    await api.sendCommand(sessionId, {
      prompt,
      attachmentIds: attachmentIds.length ? attachmentIds : undefined,
    });
  }

  async function onCancel() {
    if (!entry) return;
    const active = entry.commands.find((c) =>
      ['pending', 'sent', 'running'].includes(c.status),
    );
    if (active) await api.cancelCommand(active.id);
  }

  const elapsed = running ? relativeTime(entry.session.updatedAt) : null;

  return (
    <div className="flex h-full">
      <div className="flex flex-col flex-1 min-w-0">
        <div className="shrink-0 flex items-center gap-3 px-5 pt-4 pb-3 min-h-[52px]">
          <button
            onClick={toggleSidebar}
            className="md:hidden text-fg-tertiary hover:text-fg-primary transition-colors"
            title="show sidebar"
          >
            <Menu className="h-4 w-4" />
          </button>
          {entry.session.cliType && <AgentTypeIcon type={entry.session.cliType} />}
          <div className="flex items-center gap-2 min-w-0">
            <div className="font-display text-base font-semibold tracking-tight text-fg-primary truncate">
              {entry.session.title}
            </div>
            {elapsed && <span className="text-xs text-fg-tertiary">· {elapsed}</span>}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <UsageBadge
              chunks={entry.chunks}
              agentType={entry.session.cliType ?? undefined}
              // /compact is a REAL client-side command only on claude-code
              // (codex/cursor print modes role-play a fake "Compacted."
              // reply — verified against both binaries), and compaction
              // can't overlap a running turn.
              onCompact={
                entry.session.cliType === 'claude-code' && !running
                  ? () => void onSend('/compact', [])
                  : undefined
              }
            />
            <Button
              size="icon"
              variant="ghost"
              onClick={toggleContextPane}
              title={contextPaneOpen ? 'hide context' : 'show context'}
              className="hidden md:inline-flex"
            >
              {contextPaneOpen ? (
                <PanelRightClose className="h-3.5 w-3.5" />
              ) : (
                <PanelRightOpen className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>

        <FileTabStrip scope={projectRef?.projectId} />

        <div className="flex-1 min-h-0">
          {activeFile ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-xs text-fg-tertiary">
                  loading viewer…
                </div>
              }
            >
              <FileViewer file={activeFile} />
            </Suspense>
          ) : (
            <StreamViewer
              project={projectRef}
              sessionId={entry.session.id}
              commands={entry.commands}
              chunks={entry.chunks}
              running={running}
              workingDir={projectRef?.workingDir}
              hasMore={entry.hasMore}
              loadingOlder={entry.loadingOlder}
              onLoadOlder={onLoadOlder}
            />
          )}
        </div>

        {/* Composer is the chat surface — only show it on the chat
            tab. File tabs are read-only previews. */}
        {!activeFile && (
          <Composer
            key={sessionId}
            sessionId={sessionId}
            onSend={onSend}
            onCancel={onCancel}
            running={running}
            disabled={machineOffline}
            initial={draft}
            onChange={(v) => sessionId && setDraft(sessionId, v)}
            placeholder={
              machineOffline
                ? `${machine?.name ?? 'machine'} is offline`
                : 'Request changes or ask a question…'
            }
          />
        )}
      </div>

      {contextPaneOpen && (
        <div
          ref={contextPaneRef}
          style={{ width: contextPaneWidth }}
          className="relative shrink-0 hidden md:block"
        >
          <ResizeHandle
            side="left"
            targetRef={contextPaneRef}
            onResize={setContextPaneWidth}
          />
          <ContextPane
            session={entry.session}
            commands={entry.commands}
            chunks={entry.chunks}
          />
        </div>
      )}
    </div>
  );
}
