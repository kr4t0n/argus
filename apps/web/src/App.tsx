import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { useAuthStore } from './stores/authStore';
import { useAgentStore } from './stores/agentStore';
import { useSessionStore } from './stores/sessionStore';
import { ensureSocket, resetSocket, subscribeHandler } from './lib/ws';
import { api } from './lib/api';

function ProtectedRoutes() {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/sessions/:sessionId" element={<Dashboard />} />
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
    loadAgents();
    loadSessions();
    const socket = ensureSocket();

    const unsub = subscribeHandler({
      onAgentUpsert: upsertAgent,
      onAgentStatus: (p) => setAgentStatus(p.id, p.status),
      onSessionCreated: upsertSession,
      onSessionUpdated: upsertSession,
      onSessionStatus: (p) => {
        const entry = useSessionStore.getState().entries[p.id];
        if (entry) upsertSession({ ...entry.session, status: p.status });
      },
      onCommandCreated: upsertCommand,
      onCommandUpdated: upsertCommand,
      onChunk: appendChunk,
      onConnect: async () => {
        // re-sync agents/sessions + backfill active sessions.
        await Promise.all([loadAgents(), loadSessions()]).catch(() => {});
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
    <Routes location={location}>
      <Route path="/login" element={<Login />} />
      <Route path="/*" element={<ProtectedRoutes />} />
    </Routes>
  );
}
