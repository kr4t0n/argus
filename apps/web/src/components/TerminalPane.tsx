import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Loader2, Power, RotateCcw, Terminal as TerminalIcon, X } from 'lucide-react';
import type {
  AgentDTO,
  TerminalDTO,
  TerminalOutputMessage,
  TerminalClosedMessage,
} from '@argus/shared-types';
import { api } from '../lib/api';
import {
  joinTerminal,
  leaveTerminal,
  sendTerminalClose,
  sendTerminalInput,
  sendTerminalResize,
  subscribeHandler,
} from '../lib/ws';
import { useResolvedTheme } from '../lib/theme';
import { cn } from '../lib/utils';

type Props = {
  agent: AgentDTO;
};

type Status =
  | { kind: 'idle' }
  | { kind: 'opening' }
  | { kind: 'open'; terminal: TerminalDTO }
  | { kind: 'closed'; terminal: TerminalDTO; exitCode: number; reason?: string }
  | { kind: 'error'; message: string };

// Shared UTF-8 codec instances — cheap to construct but no reason to
// rebuild them per keystroke / per output frame.
const utf8Encoder = new TextEncoder();

/**
 * Decode base64 → Uint8Array of raw bytes. We route bytes (not strings)
 * into xterm so its UTF-8 decoder can stitch multi-byte glyphs correctly,
 * even across frame boundaries.
 */
function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Encode a JS string as UTF-8 then base64. Using `btoa(str)` directly
 * throws on any codepoint > 0xFF, which would drop pasted emoji/CJK.
 */
function encodeUtf8Base64(s: string): string {
  const bytes = utf8Encoder.encode(s);
  let bin = '';
  // String.fromCharCode spread works but blows the stack for huge pastes;
  // chunk to stay safe without sacrificing throughput for normal typing.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Interactive PTY pane bound to a single agent. Owns one xterm instance
 * for the lifetime of an open terminal; if the user closes & reopens we
 * dispose and rebuild so we get a clean scrollback.
 *
 * Buffering of out-of-order output:
 *   The sidecar tags every output message with a monotonically
 *   increasing `seq`. Redis Streams + the per-agent consumer group
 *   guarantee in-order delivery, but on reconnect it's possible to
 *   receive a duplicate of the last message we already wrote. We track
 *   the highest seq seen and discard duplicates.
 */
export function TerminalPane({ agent }: Props) {
  const supported = agent.supportsTerminal;

  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const dataDisposeRef = useRef<(() => void) | null>(null);
  const lastSeqRef = useRef(0);
  const terminalIdRef = useRef<string | null>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);

  const teardown = useCallback(() => {
    dataDisposeRef.current?.();
    dataDisposeRef.current = null;
    resizeObsRef.current?.disconnect();
    resizeObsRef.current = null;
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }
    fitRef.current = null;
    if (terminalIdRef.current) {
      leaveTerminal(terminalIdRef.current);
      terminalIdRef.current = null;
    }
    lastSeqRef.current = 0;
  }, []);

  const open = useCallback(async () => {
    if (!supported) return;
    setStatus({ kind: 'opening' });
    try {
      // Pick a sensible initial size from the container; xterm-fit will
      // refine after mount.
      const rect = containerRef.current?.getBoundingClientRect();
      const cols = rect ? Math.max(40, Math.floor(rect.width / 8.6)) : 100;
      const rows = rect ? Math.max(10, Math.floor(rect.height / 17)) : 24;
      const t = await api.openTerminal(agent.id, { cols, rows });
      terminalIdRef.current = t.id;
      joinTerminal(t.id);
      setStatus({ kind: 'open', terminal: t });
    } catch (err) {
      setStatus({
        kind: 'error',
        message: (err as Error).message ?? 'failed to open terminal',
      });
    }
  }, [agent.id, supported]);

  const close = useCallback(() => {
    const id = terminalIdRef.current;
    if (id) sendTerminalClose(id);
  }, []);

  const reset = useCallback(() => {
    teardown();
    setStatus({ kind: 'idle' });
  }, [teardown]);

  // Mount / dispose xterm whenever we transition into 'open'.
  useEffect(() => {
    if (status.kind !== 'open') return;
    const node = containerRef.current;
    if (!node) return;

    const term = new Terminal({
      fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      allowProposedApi: true,
      theme: xtermThemeForDocument(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(node);
    fit.fit();
    term.focus();

    termRef.current = term;
    fitRef.current = fit;

    // Forward keystrokes. xterm hands us the *string* the OS would send; we
    // encode it as UTF-8 bytes and base64 that, so multi-byte characters
    // (emoji, CJK, prompt glyphs pasted in) round-trip as raw bytes to the
    // PTY instead of being mangled by btoa's latin-1 assumption.
    const dataDisp = term.onData((data) => {
      const id = terminalIdRef.current;
      if (!id) return;
      sendTerminalInput(id, encodeUtf8Base64(data));
    });
    dataDisposeRef.current = () => dataDisp.dispose();

    // Resize on container size changes; debounce to avoid hammering
    // the sidecar on continuous drags.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          fit.fit();
          const id = terminalIdRef.current;
          if (id) sendTerminalResize(id, term.cols, term.rows);
        } catch {
          /* ignore */
        }
      }, 80);
    });
    ro.observe(node);
    resizeObsRef.current = ro;

    return () => {
      dataDisp.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      dataDisposeRef.current = null;
      resizeObsRef.current = null;
    };
  }, [status.kind]);

  // Re-theme the live terminal when the dashboard theme flips.
  // xterm supports hot-swapping `options.theme` — colors update on
  // the next paint without recreating the terminal or losing scroll
  // history.
  const resolvedTheme = useResolvedTheme();
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermThemeForDocument();
  }, [resolvedTheme]);

  // Wire up WS handlers (output / closed).
  useEffect(() => {
    const off = subscribeHandler({
      onTerminalOutput: (m: TerminalOutputMessage) => {
        if (m.terminalId !== terminalIdRef.current) return;
        if (m.seq <= lastSeqRef.current) return; // duplicate after reconnect
        lastSeqRef.current = m.seq;
        try {
          // Decode base64 → raw byte array and hand the Uint8Array straight
          // to xterm. xterm's write(Uint8Array) runs its own UTF-8 decoder;
          // write(string) would treat each byte as a UTF-16 codepoint and
          // split multi-byte glyphs (e.g. "➜" → "â\x9e\x9c").
          termRef.current?.write(decodeBase64Bytes(m.data));
        } catch {
          /* ignore decode errors */
        }
      },
      onTerminalClosed: (m: TerminalClosedMessage) => {
        if (m.terminalId !== terminalIdRef.current) return;
        setStatus((s) => {
          if (s.kind !== 'open') return s;
          return { kind: 'closed', terminal: s.terminal, exitCode: m.exitCode, reason: m.reason };
        });
        // Print a closing banner inside xterm so the user sees the
        // exit code without losing the existing scrollback.
        const banner = `\r\n\x1b[2m[process exited with code ${m.exitCode}${m.reason ? ` — ${m.reason}` : ''}]\x1b[0m\r\n`;
        termRef.current?.write(banner);
      },
    });
    return off;
  }, []);

  // On unmount or agent switch, teardown completely.
  useEffect(() => {
    return () => teardown();
  }, [teardown]);

  // When the user switches agents, drop the open terminal and reset.
  useEffect(() => {
    return () => {
      // Note: we don't auto-close the PTY on agent switch — the user
      // may want to come back to it. The sidecar will reap it when the
      // shell exits or after the per-sidecar maxSessions cap. If you
      // want strict cleanup, call `close()` here.
    };
  }, [agent.id]);

  if (!supported) {
    return (
      <div className="space-y-1">
        <div className="text-xs text-fg-tertiary">
          this agent's sidecar has not opted into terminals.
        </div>
        <div className="text-[11px] text-fg-muted">
          set <span className="font-mono text-fg-tertiary">terminal.enabled: true</span> in its YAML
          and restart.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-[11px] text-fg-tertiary">
        <span>
          {status.kind === 'open' && 'connected'}
          {status.kind === 'opening' && 'connecting…'}
          {status.kind === 'closed' && `exited (${status.exitCode})`}
          {status.kind === 'idle' && 'no session'}
          {status.kind === 'error' && <span className="text-red-400">error: {status.message}</span>}
        </span>
        <div className="flex items-center gap-1">
          {status.kind === 'idle' && (
            <button
              onClick={open}
              className="inline-flex items-center gap-1 rounded-md border border-default bg-surface-1 px-2 py-0.5 text-[11px] text-fg-secondary hover:bg-surface-2"
            >
              <TerminalIcon className="h-3 w-3" /> open
            </button>
          )}
          {status.kind === 'opening' && (
            <Loader2 className="h-3 w-3 animate-spin text-fg-tertiary" />
          )}
          {status.kind === 'open' && (
            <button
              onClick={close}
              title="close (sends SIGHUP-equivalent)"
              className="inline-flex items-center gap-1 rounded-md border border-default bg-surface-1 px-2 py-0.5 text-[11px] text-fg-secondary hover:bg-surface-2"
            >
              <Power className="h-3 w-3" /> close
            </button>
          )}
          {(status.kind === 'closed' || status.kind === 'error') && (
            <>
              <button
                onClick={reset}
                title="dismiss"
                className="inline-flex items-center rounded-md border border-default bg-surface-1 p-1 text-fg-tertiary hover:bg-surface-2"
              >
                <X className="h-3 w-3" />
              </button>
              <button
                onClick={() => {
                  reset();
                  open();
                }}
                title="restart"
                className="inline-flex items-center gap-1 rounded-md border border-default bg-surface-1 px-2 py-0.5 text-[11px] text-fg-secondary hover:bg-surface-2"
              >
                <RotateCcw className="h-3 w-3" /> restart
              </button>
            </>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        onClick={() => termRef.current?.focus()}
        className={cn(
          'relative h-[280px] w-full rounded-md border border-default bg-surface-0 p-1.5',
          // Keep the inner xterm canvas snug against the rounded border.
          status.kind !== 'open' && status.kind !== 'closed' && 'flex items-center justify-center',
        )}
      >
        {status.kind === 'idle' && (
          <div className="text-center text-[11px] text-fg-muted">
            click <span className="text-fg-tertiary">open</span> to attach a shell on{' '}
            <span className="font-mono text-fg-tertiary">{agent.machineName}</span>
          </div>
        )}
        {status.kind === 'opening' && <Loader2 className="h-4 w-4 animate-spin text-fg-tertiary" />}
        {status.kind === 'error' && (
          <div className="text-center text-[11px] text-red-400">{status.message}</div>
        )}
      </div>
    </div>
  );
}

// xterm color themes. We bake two per-theme palettes (matching the
// dashboard tokens) and pick by the dark class on <html>. Hot-swapping
// `term.options.theme` triggers an in-place repaint so flipping the
// dashboard theme doesnt drop scroll position or kill the PTY.
const XTERM_DARK = {
  background: '#0a0a0a',
  foreground: '#e5e5e5',
  cursor: '#a3a3a3',
  cursorAccent: '#0a0a0a',
  selectionBackground: '#525252',
  black: '#171717',
  brightBlack: '#404040',
  red: '#ef4444',
  brightRed: '#f87171',
  green: '#22c55e',
  brightGreen: '#4ade80',
  yellow: '#eab308',
  brightYellow: '#facc15',
  blue: '#3b82f6',
  brightBlue: '#60a5fa',
  magenta: '#a855f7',
  brightMagenta: '#c084fc',
  cyan: '#06b6d4',
  brightCyan: '#22d3ee',
  white: '#e5e5e5',
  brightWhite: '#fafafa',
};

const XTERM_LIGHT = {
  background: '#ffffff',
  foreground: '#171717',
  cursor: '#525252',
  cursorAccent: '#ffffff',
  selectionBackground: '#cccccc',
  black: '#171717',
  brightBlack: '#404040',
  red: '#dc2626',
  brightRed: '#ef4444',
  green: '#16a34a',
  brightGreen: '#22c55e',
  yellow: '#ca8a04',
  brightYellow: '#eab308',
  blue: '#2563eb',
  brightBlue: '#3b82f6',
  magenta: '#9333ea',
  brightMagenta: '#a855f7',
  cyan: '#0891b2',
  brightCyan: '#06b6d4',
  white: '#525252',
  brightWhite: '#171717',
};

function xtermThemeForDocument() {
  if (typeof document === 'undefined') return XTERM_DARK;
  return document.documentElement.classList.contains('dark') ? XTERM_DARK : XTERM_LIGHT;
}
