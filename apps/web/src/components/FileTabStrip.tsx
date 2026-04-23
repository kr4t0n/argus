import { FileText, MessageSquare, X } from 'lucide-react';
import {
  useFileTabsStore,
  type OpenFile,
} from '../stores/fileTabsStore';
import { cn } from '../lib/utils';

type Props = {
  /** Tabs are filtered to this agent's files. Other agents' tabs stay
   *  in the store but are hidden so the strip stays in-context for the
   *  currently viewed session. */
  agentId: string | null | undefined;
};

/**
 * Tab strip rendered above the main content area in SessionPanel.
 * Hidden entirely when the agent has no open file tabs — the
 * dashboard reads exactly as before this feature when no file is
 * being previewed. The chat tab is always first and pinned (no close
 * button); file tabs render to the right of it in open order.
 */
export function FileTabStrip({ agentId }: Props) {
  const openFiles = useFileTabsStore((s) => s.openFiles);
  const activeKey = useFileTabsStore((s) => s.activeKey);
  const setActive = useFileTabsStore((s) => s.setActive);
  const closeFile = useFileTabsStore((s) => s.closeFile);

  if (!agentId) return null;
  const tabs = openFiles.filter((f) => f.agentId === agentId);
  if (tabs.length === 0) return null;

  // The chat tab is "active" both when activeKey is null AND when the
  // current activeKey points to a different agent's file (we hide
  // those tabs, so chat is the only displayable surface).
  const fileActive = tabs.find((f) => f.key === activeKey);
  const chatActive = !fileActive;

  return (
    <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-neutral-900 bg-neutral-950 px-2">
      <ChatTab active={chatActive} onClick={() => setActive(null)} />
      {tabs.map((f) => (
        <FileTab
          key={f.key}
          file={f}
          active={activeKey === f.key}
          onClick={() => setActive(f.key)}
          onClose={() => closeFile(f.key)}
        />
      ))}
    </div>
  );
}

function ChatTab({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Chat"
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs transition-colors',
        active
          ? 'border-neutral-100 text-neutral-100'
          : 'border-transparent text-neutral-500 hover:text-neutral-300',
      )}
    >
      <MessageSquare className="h-3 w-3" />
      Chat
    </button>
  );
}

function FileTab({
  file,
  active,
  onClick,
  onClose,
}: {
  file: OpenFile;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        'group relative inline-flex shrink-0 items-stretch border-b-2 transition-colors',
        active ? 'border-neutral-100' : 'border-transparent',
      )}
    >
      <button
        type="button"
        onClick={onClick}
        // Middle-click closes — matches the convention every multi-tab
        // editor (and every browser) uses.
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            onClose();
          }
        }}
        title={file.path}
        className={cn(
          'inline-flex items-center gap-1.5 py-2 pl-3 pr-7 text-xs',
          active ? 'text-neutral-100' : 'text-neutral-500 hover:text-neutral-300',
        )}
      >
        <FileText className="h-3 w-3 shrink-0 text-neutral-500" />
        <span className="max-w-[180px] truncate">{file.name}</span>
      </button>
      <button
        type="button"
        onClick={onClose}
        title="Close tab"
        aria-label={`Close ${file.name}`}
        className={cn(
          'absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-600 transition-opacity hover:bg-neutral-800 hover:text-neutral-300',
          // Always visible on the active tab so the user has an easy
          // exit; hover-revealed for inactive tabs to keep the strip
          // visually quiet when several files are open.
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
        )}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
