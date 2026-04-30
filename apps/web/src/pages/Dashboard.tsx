import { useEffect, useRef } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar';
import { SidebarRail } from '../components/SidebarRail';
import { SessionPanel } from '../components/SessionPanel';
import { MachinePanel } from '../components/MachinePanel';
import { UserPanel } from './UserPanel';
import { ResizeHandle } from '../components/ui/ResizeHandle';
import { useUIStore } from '../stores/uiStore';

const RAIL_WIDTH = 48;
const MOBILE_DRAWER_WIDTH = 288;

export function Dashboard() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const { machineId } = useParams();
  const location = useLocation();
  // /user is a top-level pane (no params) sibling to MachinePanel /
  // SessionPanel. Path-prefix match because react-router doesn't
  // expose the matched route name to <Dashboard> itself.
  const isUserPane = location.pathname.startsWith('/user');
  const prevPath = useRef(location.pathname);
  // Auto-close the mobile drawer on navigate so tapping a session in
  // the sidebar lands you on the chat rather than under the overlay.
  useEffect(() => {
    if (prevPath.current === location.pathname) return;
    prevPath.current = location.pathname;
    if (window.innerWidth < 768 && sidebarOpen) toggleSidebar();
  }, [location.pathname, sidebarOpen, toggleSidebar]);
  return (
    <div className="h-screen w-screen flex overflow-x-hidden">
      {/* Desktop sidebar (in flow). Full panel when open, rail when
          collapsed. The rail is hidden on mobile since a 48px
          permanent gutter eats too much of a phone's width. */}
      <div
        ref={sidebarRef}
        style={{ width: sidebarOpen ? sidebarWidth : RAIL_WIDTH }}
        className="hidden md:block relative shrink-0 h-full"
      >
        {sidebarOpen ? <Sidebar /> : <SidebarRail />}
        {sidebarOpen && (
          <ResizeHandle side="right" targetRef={sidebarRef} onResize={setSidebarWidth} />
        )}
      </div>

      {/* Mobile drawer: overlay instead of pushing content, and
          completely unmounted when closed. */}
      {sidebarOpen && (
        <>
          <div className="fixed inset-0 z-30 bg-black/60 md:hidden" onClick={toggleSidebar} />
          <div
            style={{ width: MOBILE_DRAWER_WIDTH }}
            className="fixed inset-y-0 left-0 z-40 h-full md:hidden"
          >
            <Sidebar />
          </div>
        </>
      )}

      <main className="flex-1 min-w-0 h-full">
        {isUserPane ? <UserPanel /> : machineId ? <MachinePanel /> : <SessionPanel />}
      </main>
    </div>
  );
}
