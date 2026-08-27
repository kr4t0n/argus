import { useEffect, useRef } from 'react';

/**
 * Cmd/Ctrl + `key`, bound globally.
 *
 * One home for every app-level shortcut, so the guards below are written
 * once instead of copied per binding. Registered in the CAPTURE phase and
 * `preventDefault`ed: the xterm terminal pane would otherwise forward the
 * keystroke to the PTY, and browsers claim several of these themselves
 * (Ctrl+K is Firefox's search bar, ⌘P/Ctrl+P is Print everywhere).
 *
 * A modifier combo is why this needs no "is the user typing?" guard —
 * unlike a bare key it can't fire by accident mid-sentence, so it works
 * from inside the composer too.
 */
export function useGlobalHotkey(key: string, handler: () => void): void {
  // Held in a ref so the listener is registered once per key rather than
  // re-bound on every parent render, and callers don't need useCallback.
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const target = key.toLowerCase();
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== target) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      // Leave the shifted/alted variants alone — ⌘⇧P is a different
      // shortcut in every editor, and swallowing it here would make it
      // impossible to bind later.
      if (e.shiftKey || e.altKey) return;
      // Readline owns Ctrl+K (kill-line) and Ctrl+P (previous-command).
      // While the terminal has focus those belong to the shell, so only
      // the Ctrl form defers — ⌘ is never forwarded to a PTY, so the Cmd
      // binding keeps working everywhere including inside the terminal.
      if (e.ctrlKey && !e.metaKey && isTerminalFocused()) return;
      e.preventDefault();
      e.stopPropagation();
      handlerRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [key]);
}

/** xterm takes keystrokes through a hidden textarea inside the `.xterm`
 *  container it adds to the node passed to `term.open()`. */
function isTerminalFocused(): boolean {
  const el = document.activeElement;
  return el instanceof Element && !!el.closest('.xterm');
}
