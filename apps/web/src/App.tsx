import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { useAuthStore } from './stores/authStore';
import { useAgentStore } from './stores/agentStore';
import { useMachineStore } from './stores/machineStore';
import { useSessionStore } from './stores/sessionStore';
import { useSidecarUpdateStore } from './stores/sidecarUpdateStore';
import { ensureSocket, resetSocket, subscribeHandler } from './lib/ws';
import { api } from './lib/api';
import { SidecarUpdateToasts } from './components/SidecarUpdateToasts';

function ProtectedRoutes() {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/sessions/:sessionId" element={<Dashboard />} />
      <Route path="/machines/:machineId" element={<Dashboard />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
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
    loadMachines();
    loadAgents();
    loadSessions();
    const socket = ensureSocket();

    const updateStore = useSidecarUpdateStore.getState();

    const unsub = subscribeHandler({
      onMachineUpsert: upsertMachine,
      onMachineStatus: (p) => setMachineStatus(p.id, p.status),
      onMachineRemoved: (p) => removeMachine(p.id),
      onAgentUpsert: upsertAgent,
      onAgentStatus: (p) => setAgentStatus(p.id, p.status),
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
      onSidecarUpdateStarted: (p) =>
        updateStore.setStarted(p.machineId, p.fromVersion),
      onSidecarUpdateDownloaded: (p) =>
        updateStore.setDownloaded(
          p.machineId,
          p.fromVersion,
          p.toVersion,
          p.restartMode,
        ),
      onSidecarUpdateCompleted: (p) =>
        updateStore.setCompleted(p.machineId, p.fromVersion, p.toVersion),
      onSidecarUpdateFailed: (p) =>
        updateStore.setFailed(p.machineId, p.fromVersion, p.reason),
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
      <SidecarUpdateToasts />
    </>
  );
}
