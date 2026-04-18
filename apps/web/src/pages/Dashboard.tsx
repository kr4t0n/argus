import { Sidebar } from '../components/Sidebar';
import { SessionPanel } from '../components/SessionPanel';
import { useUIStore } from '../stores/uiStore';

export function Dashboard() {
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  return (
    <div className="h-screen w-screen flex">
      <div style={{ width: sidebarWidth }} className="shrink-0 h-full">
        <Sidebar />
      </div>
      <main className="flex-1 min-w-0 h-full">
        <SessionPanel />
      </main>
    </div>
  );
}
