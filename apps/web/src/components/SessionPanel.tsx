import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Menu, PanelRightClose, PanelRightOpen, Square } from 'lucide-react';
import { useAgentStore } from '../stores/agentStore';
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
  const backfill = useSessionStore((s) => s.backfill);
  const agent = useAgentStore((s) =>
    entry?.session ? s.agents[entry.session.agentId] : undefined,
  );

  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const contextPaneOpen = useUIStore((s) => s.contextPaneOpen);
  const toggleContextPane = useUIStore((s) => s.toggleContextPane);
  const contextPaneWidth = useUIStore((s) => s.contextPaneWidth);
  const setContextPaneWidth = useUIStore((s) => s.setContextPaneWidth);
  const contextPaneRef = useRef<HTMLDivElement | null>(null);
  const draft = useUIStore((s) =>
    agent ? s.drafts[agent.id] ?? '' : '',
  );
  const setDraft = useUIStore((s) => s.setDraft);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);

    // We unsubscribe from the session room on navigation away, so any
    // chunks / command-status updates that land for THIS session while
    // the user was viewing another one go unobserved by the WS layer.
    // Server still persists them; we just need to ask. `loadSession`
    // short-circuits when an entry is already `loaded`, so we have to
    // run a tail-gap backfill ourselves on re-entry — same primitive
    // App.tsx uses on WS reconnect.
    const wasLoaded = !!useSessionStore.getState().entries[sessionId]?.loaded;
    loadSession(sessionId)
      .then(async (entry) => {
        if (!wasLoaded) return;
        try {
          const { commands, chunks } = await api.getSessionChunks(sessionId, entry.lastSeq);
          if (commands.length || chunks.length) {
            backfill(sessionId, commands, chunks);
          }
        } catch {
          /* visible state stays as it was; user can still hard-refresh */
        }
      })
      .catch((err) => setError(err.message ?? 'failed to load session'))
      .finally(() => setLoading(false));
    joinSession(sessionId);
    return () => {
      leaveSession(sessionId);
    };
  }, [sessionId, loadSession, backfill]);

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

  // File tabs: filtered to the current agent so the strip stays in
  // context. The active tab is "the chat" when nothing's selected OR
  // when the selection points to a different agent's file (those tabs
  // are hidden but the store still remembers them, so navigating back
  // to the original agent restores the selection).
  const openFiles = useFileTabsStore((s) => s.openFiles);
  const activeFileKey = useFileTabsStore((s) => s.activeKey);
  const activeFile = useMemo(() => {
    if (!agent || !activeFileKey) return null;
    return openFiles.find(
      (f) => f.key === activeFileKey && f.agentId === agent.id,
    ) ?? null;
  }, [openFiles, activeFileKey, agent?.id]);

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

  if (loading && !entry) {
    return <div className="p-6 text-fg-tertiary text-sm">loading…</div>;
  }

  if (error) {
    return <div className="p-6 text-red-400 text-sm">{error}</div>;
  }

  if (!entry) return null;

  async function onSend(prompt: string) {
    if (!sessionId) return;
    await api.sendCommand(sessionId, { prompt });
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
        <div className="h-12 shrink-0 flex items-center gap-3 px-5 border-b border-default">
          <button
            onClick={toggleSidebar}
            className="md:hidden text-fg-tertiary hover:text-fg-primary transition-colors"
            title="show sidebar"
          >
            <Menu className="h-4 w-4" />
          </button>
          {agent && <AgentTypeIcon type={agent.type} />}
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm font-medium text-fg-primary truncate">
              {entry.session.title}
            </div>
            {elapsed && <span className="text-xs text-fg-tertiary">· {elapsed}</span>}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <UsageBadge chunks={entry.chunks} agentType={agent?.type} />
            {running && (
              <Button size="sm" variant="subtle" onClick={onCancel}>
                <Square className="h-3 w-3" />
                Cancel
              </Button>
            )}
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

        <FileTabStrip agentId={agent?.id} />

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
              commands={entry.commands}
              chunks={entry.chunks}
              running={running}
              workingDir={agent?.workingDir}
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
            onSend={onSend}
            onCancel={onCancel}
            running={running}
            disabled={!agent || agent.status === 'offline'}
            initial={draft}
            onChange={(v) => agent && setDraft(agent.id, v)}
            placeholder={
              agent?.status === 'offline'
                ? `${agent.machineName} is offline`
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
            agent={agent}
            session={entry.session}
            recentCommands={entry.commands}
            chunks={entry.chunks}
          />
        </div>
      )}
    </div>
  );
}
