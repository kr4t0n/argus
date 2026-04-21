import { useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar';
import { SidebarRail } from '../components/SidebarRail';
import { SessionPanel } from '../components/SessionPanel';
import { MachinePanel } from '../components/MachinePanel';
import { ResizeHandle } from '../components/ui/ResizeHandle';
import { useUIStore } from '../stores/uiStore';

const RAIL_WIDTH = 48;

export function Dashboard() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const { machineId } = useParams();
  return (
    <div className="h-screen w-screen flex">
      <div
        ref={sidebarRef}
        style={{ width: sidebarOpen ? sidebarWidth : RAIL_WIDTH }}
        className="relative shrink-0 h-full"
      >
        {sidebarOpen ? <Sidebar /> : <SidebarRail />}
        {sidebarOpen && (
          <ResizeHandle side="right" targetRef={sidebarRef} onResize={setSidebarWidth} />
        )}
      </div>
      <main className="flex-1 min-w-0 h-full">
        {machineId ? <MachinePanel /> : <SessionPanel />}
      </main>
    </div>
  );
}
