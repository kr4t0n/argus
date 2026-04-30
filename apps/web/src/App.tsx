import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { useAuthStore } from './stores/authStore';
import { useAgentStore } from './stores/agentStore';
import { useMachineStore } from './stores/machineStore';
import { useSessionStore } from './stores/sessionStore';
import { useSidecarUpdateStore } from './stores/sidecarUpdateStore';
import { useCloneFailureStore } from './stores/cloneFailureStore';
import { ensureSocket, resetSocket, subscribeHandler } from './lib/ws';
import { api } from './lib/api';
import { migrateLocalMachineIconsToServer } from './lib/migrateMachineIcons';
import {
  SidecarUpdateBatchDismissAll,
  SidecarUpdateToasts,
} from './components/SidecarUpdateToasts';
import { SessionCloneFailedToasts } from './components/SessionCloneFailedToasts';
import { useApplyTheme } from './lib/theme';

function ProtectedRoutes() {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/sessions/:sessionId" element={<Dashboard />} />
      <Route path="/machines/:machineId" element={<Dashboard />} />
      <Route path="/user" element={<Dashboard />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  // Keep <html>'s dark class in sync with the persisted theme +
  // OS preference. Runs once at mount; idempotent.
  useApplyTheme();

  const bootstrap = useAuthStore((s) => s.bootstrap);
  const token = useAuthStore((s) => s.token);
  const loadAgents = useAgentStore((s) => s.load);
  const upsertAgent = useAgentStore((s) => s.upsert);
  const setAgentStatus = useAgentStore((s) => s.setStatus);
  const removeAgent = useAgentStore((s) => s.remove);
  const loadMachines = useMachineStore((s) => s.load);
  const upsertMachine = useMachineStore((s) => s.upsert);
  const setMachineStatus = useMachineStore((s) => s.setStatus);
  const removeMachine = useMachineStore((s) => s.remove);
  const loadSessions = useSessionStore((s) => s.loadList);
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const upsertCommand = useSessionStore((s) => s.upsertCommand);
  const appendChunk = useSessionStore((s) => s.appendChunk);
  const backfill = useSessionStore((s) => s.backfill);
  const entries = useSessionStore((s) => s.entries);
  const location = useLocation();

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!token) return;
    // Kick off loads first, then run the one-shot localStorage →
    // server migration for machine icons once the machines list has
    // landed (the migration needs to know which machineIds are still
    // valid to avoid 404-spamming for destroyed hosts).
    loadMachines().then(() => migrateLocalMachineIconsToServer());
    loadAgents();
    loadSessions();
    const socket = ensureSocket();

    const updateStore = useSidecarUpdateStore.getState();

    const unsub = subscribeHandler({
      onMachineUpsert: upsertMachine,
      onMachineStatus: (p) => setMachineStatus(p.id, p.status),
      onMachineRemoved: (p) => removeMachine(p.id),
      onAgentUpsert: upsertAgent,
      onAgentStatus: (p) => {
        // Prefetch trigger: when an agent transitions busy → not-busy,
        // any session on that agent whose cached state still says
        // "running" almost certainly just finished. Force-refresh
        // those sessions silently in the background so the user sees
        // the fresh state instantly when they navigate back, rather
        // than the brief loading flash from SessionPanel's mount
        // effect catching up. Read prev status BEFORE updating so we
        // can detect the transition.
        const prev = useAgentStore.getState().agents[p.id]?.status;
        setAgentStatus(p.id, p.status);
        if (prev === 'busy' && p.status !== 'busy') {
          const ss = useSessionStore.getState();
          for (const e of Object.values(ss.entries)) {
            if (e.session.agentId !== p.id) continue;
            const stillRunning = e.commands.some((c) =>
              ['pending', 'sent', 'running'].includes(c.status),
            );
            if (!stillRunning) continue;
            void ss.loadSession(e.session.id, { force: true }).catch(() => {
              /* silent — re-entry will retry */
            });
          }
        }
      },
      onAgentRemoved: (p) => removeAgent(p.id),
      onSessionCreated: upsertSession,
      onSessionUpdated: upsertSession,
      onSessionStatus: (p) => {
        const entry = useSessionStore.getState().entries[p.id];
        if (entry) upsertSession({ ...entry.session, status: p.status });
      },
      onCommandCreated: upsertCommand,
      onCommandUpdated: upsertCommand,
      onChunk: appendChunk,
      onSessionCloneFailed: (p) => {
        // Look the session up at push time so the toast can show the
        // human title even if the row hasn't fully hydrated yet (the
        // session:created event may still be in flight; fall back to
        // the id so we never render an empty label).
        const sess = useSessionStore.getState().entries[p.sessionId]?.session;
        useCloneFailureStore.getState().push({
          sessionId: p.sessionId,
          sessionTitle: sess?.title ?? p.sessionId.slice(0, 8),
          reason: p.reason,
          startedAt: Date.now(),
        });
      },
      onSidecarUpdateStarted: (p) => updateStore.setStarted(p.machineId, p.fromVersion),
      onSidecarUpdateDownloaded: (p) =>
        updateStore.setDownloaded(p.machineId, p.fromVersion, p.toVersion, p.restartMode),
      onSidecarUpdateCompleted: (p) =>
        updateStore.setCompleted(p.machineId, p.fromVersion, p.toVersion),
      onSidecarUpdateFailed: (p) => updateStore.setFailed(p.machineId, p.fromVersion, p.reason),
      onSidecarUpdateBatchProgress: (p) =>
        useSidecarUpdateStore.getState().updateBatch(p.batchId, p.plan),
      onConnect: async () => {
        // re-sync machines/agents/sessions + backfill active sessions.
        await Promise.all([loadMachines(), loadAgents(), loadSessions()]).catch(() => {});
        const entriesSnap = useSessionStore.getState().entries;
        for (const [id, e] of Object.entries(entriesSnap)) {
          try {
            const { commands, chunks } = await api.getSessionChunks(id, e.lastSeq);
            if (commands.length || chunks.length) backfill(id, commands, chunks);
          } catch {
            /* ignore */
          }
        }
      },
    });

    return () => {
      unsub();
      socket.disconnect();
      resetSocket();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <>
      <Routes location={location}>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={<ProtectedRoutes />} />
      </Routes>
      {/* Single host for every transient bottom-right toast type so
          stacks combine into one column instead of overlapping at the
          same screen coords. Toast components return Fragments of items
          and inherit layout from this wrapper. The "dismiss all"
          affordance for sidecar-update batches lives last so it always
          sits at the bottom edge of the combined stack. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        <SidecarUpdateToasts />
        <SessionCloneFailedToasts />
        <SidecarUpdateBatchDismissAll />
      </div>
    </>
  );
}
