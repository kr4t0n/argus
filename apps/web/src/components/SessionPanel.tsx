import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PanelRightClose, PanelRightOpen, Square } from 'lucide-react';
import { useAgentStore } from '../stores/agentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { api } from '../lib/api';
import { joinSession, leaveSession } from '../lib/ws';
import { StatusDot } from './ui/StatusDot';
import { AgentTypeIcon, agentTypeLabel } from './ui/AgentTypeIcon';
import { Button } from './ui/Button';
import { ResizeHandle } from './ui/ResizeHandle';
import { StreamViewer } from './StreamViewer';
import { Composer } from './Composer';
import { ContextPane } from './ContextPane';
import { relativeTime } from '../lib/utils';

export function SessionPanel() {
  const { sessionId } = useParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entry = useSessionStore((s) => (sessionId ? s.entries[sessionId] : undefined));
  const loadSession = useSessionStore((s) => s.loadSession);
  const agent = useAgentStore((s) =>
    entry?.session ? s.agents[entry.session.agentId] : undefined,
  );

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
    loadSession(sessionId)
      .catch((err) => setError(err.message ?? 'failed to load session'))
      .finally(() => setLoading(false));
    joinSession(sessionId);
    return () => {
      leaveSession(sessionId);
    };
  }, [sessionId, loadSession]);

  const running = useMemo(() => {
    if (!entry) return false;
    return entry.commands.some((c) =>
      ['pending', 'sent', 'running'].includes(c.status),
    );
  }, [entry]);

  if (!sessionId) {
    return (
      <div className="flex h-full items-center justify-center text-neutral-500 text-sm">
        Select or start a session from the left.
      </div>
    );
  }

  if (loading && !entry) {
    return <div className="p-6 text-neutral-500 text-sm">loading…</div>;
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
        <div className="h-12 shrink-0 flex items-center gap-3 px-5 border-b border-neutral-900">
          {agent && <AgentTypeIcon type={agent.type} />}
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm font-medium text-neutral-100 truncate">
              {entry.session.title}
            </div>
            {agent && (
              <span className="text-xs text-neutral-500 truncate">
                · {agentTypeLabel(agent.type)} · {agent.machineName}
              </span>
            )}
            {agent && <StatusDot status={agent.status} />}
            {elapsed && <span className="text-xs text-neutral-500">· {elapsed}</span>}
          </div>
          <div className="ml-auto flex items-center gap-1">
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
            >
              {contextPaneOpen ? (
                <PanelRightClose className="h-3.5 w-3.5" />
              ) : (
                <PanelRightOpen className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>

        <div className="flex-1 min-h-0">
          <StreamViewer
            commands={entry.commands}
            chunks={entry.chunks}
            running={running}
            workingDir={agent?.workingDir}
          />
        </div>

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
          />
        </div>
      )}
    </div>
  );
}
