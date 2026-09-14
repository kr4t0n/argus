import { useEffect, useRef } from 'react';
import { usePaletteStore } from '../stores/paletteStore';

/**
 * "Start typing anywhere in the session and the keystroke lands in the
 * composer" — the chat-app convention, so it needs no learning and costs
 * no key real estate.
 *
 * Deliberately NOT built on `useGlobalHotkey`. That hook's whole
 * simplification is that a Cmd/Ctrl combo cannot fire mid-sentence, so it
 * needs no "is the user busy?" guard. A bare key gives that up and has to
 * earn it back, which is what every condition below is doing.
 *
 * **It does not insert the character.** It focuses the textarea during
 * `keydown` and never calls `preventDefault`, so the same keystroke lands
 * in the newly-focused element by itself. Inserting `e.key` by hand is
 * what breaks IME composition and dead keys — `Composer` already guards
 * `isComposing` on Enter for exactly that reason.
 *
 * @param enabled  false unmounts the listener entirely — pass false when
 *                 there is no composer to focus (no session open, or a
 *                 file tab is showing, which unmounts it).
 * @param focus    focuses the composer's textarea.
 */
export function useTypeToFocus(enabled: boolean, focus: () => void): void {
  const focusRef = useRef(focus);
  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);

  useEffect(() => {
    if (!enabled) return;

    const onKey = (e: KeyboardEvent) => {
      // A modifier means the user is reaching for a shortcut, not typing.
      // Without this, ⌘K would focus the composer and leave a "k" in it.
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Printable single characters only. `length !== 1` excludes Escape,
      // Tab, Enter, the arrows and every F-key without enumerating them.
      if (e.key.length !== 1) return;

      // Space is excluded ON PURPOSE, and it is the most important
      // exclusion here. It pages the transcript while you read, and it
      // activates whatever control has focus — so letting it through both
      // breaks scrolling and silently swallows button activation. Nobody
      // opens a message with a space, so this costs nothing.
      if (e.key === ' ') return;

      // Only fire when NOTHING is focused. This is stronger and far less
      // brittle than a blocklist of element types: if the user has clicked
      // or tabbed onto any control — a button, a sidebar row, ui/Select,
      // the file tree — they are driving that control, so stay out of the
      // way. Keyboard-only navigation keeps Space-to-activate and
      // typeahead intact because of this one check, and `.xterm` plus
      // every input/textarea fall out of it for free since all of them
      // take focus. It matters more here than in a pure chat app: a
      // session view also holds a file tree, file tabs, a terminal and the
      // diff/git panes, so focus legitimately sits on a control far more
      // often than in a UI where the transcript is the only surface.
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;

      // An open overlay owns the keyboard.
      if (usePaletteStore.getState().mode !== null) return;

      focusRef.current();
    };

    // Bubble phase and no preventDefault — the opposite posture to
    // `useGlobalHotkey`. This must LOSE to anything that wants the key,
    // and the keystroke has to survive to reach the focused textarea.
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
