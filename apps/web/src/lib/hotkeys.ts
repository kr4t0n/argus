/**
 * The app's keyboard bindings, in one table.
 *
 * Two things need the same list and used to have no way to share it: the
 * `useGlobalHotkey` call sites, which need the key to listen for, and the
 * shortcuts overlay, which needs a human-readable chord and label. Before
 * this existed the bindings were anonymous `useGlobalHotkey('d', …)` calls
 * scattered across components, which meant the overlay had nothing to read
 * and nothing caught two components claiming the same key.
 *
 * `key` is compared against a lowercased `KeyboardEvent.key`. `chord` and
 * `label` are display-only. `scope` says WHERE the binding is live, which
 * is a property of the mount point, not of this table — a `session`
 * binding is registered in `SessionPanel` and is simply not mounted on
 * `/machines/:id` or `/user`. Keep the two in agreement when you add one.
 */
export interface HotkeyBinding {
  /** Matched against `KeyboardEvent.key.toLowerCase()`. */
  key: string;
  /** How the chord is written in the UI. */
  chord: string;
  /** What pressing it does, phrased as an action. */
  label: string;
  /** Where it is live — also the overlay's grouping. */
  scope: 'global' | 'session';
}

export const HOTKEYS = {
  paletteSession: {
    key: 'p',
    chord: '⌘P',
    label: 'Switch to a session by name',
    scope: 'global',
  },
  paletteContent: {
    key: 'k',
    chord: '⌘K',
    label: 'Search what was said, across every session',
    scope: 'global',
  },
  toggleSidebar: {
    key: 'b',
    chord: '⌘B',
    label: 'Show or hide the sidebar',
    scope: 'global',
  },
  shortcutsHelp: {
    key: '/',
    chord: '⌘/',
    label: 'Open this list',
    scope: 'global',
  },
  archiveSession: {
    key: 'd',
    chord: '⌘D',
    label: 'Archive the open session — press again to restore',
    scope: 'session',
  },
  cancelTurn: {
    key: '.',
    chord: '⌘.',
    label: 'Stop the running turn',
    scope: 'session',
  },
} as const satisfies Record<string, HotkeyBinding>;

/**
 * Keys owned by whichever component has focus, rather than by
 * `useGlobalHotkey`.
 *
 * They are listed here so the overlay can be a complete answer to "what
 * can I press" instead of a dump of the global table — but deliberately
 * NOT in `HOTKEYS`, because nothing registers them through the hook and
 * putting them there would imply otherwise. The terminal group is the one
 * users most need told: those keys are *not* Argus bindings precisely
 * because `useGlobalHotkey` hands the Ctrl form back to the shell.
 */
export interface LocalKeyGroup {
  title: string;
  keys: ReadonlyArray<{ chord: string; label: string }>;
}

export const LOCAL_KEYS: readonly LocalKeyGroup[] = [
  {
    title: 'Composer',
    keys: [
      { chord: 'any key', label: 'Start typing anywhere to jump into the composer' },
      { chord: '⏎', label: 'Send — or queue, while a turn is running' },
      { chord: '⇧⏎', label: 'New line' },
      { chord: 'esc', label: 'Stop the running turn' },
    ],
  },
  {
    title: 'File tabs',
    keys: [{ chord: 'esc', label: 'Close the file and return to the composer' }],
  },
  {
    title: 'Command palette',
    keys: [
      { chord: '↑ ↓', label: 'Move through results' },
      { chord: '⏎', label: 'Open the selected result' },
      { chord: 'tab', label: 'Run the same query against the other index' },
      { chord: 'esc', label: 'Close' },
    ],
  },
  {
    title: 'Terminal',
    keys: [
      { chord: 'ctrl+D', label: 'EOF — reaches the shell, not Argus' },
      { chord: 'ctrl+K', label: 'Kill line — reaches the shell' },
      { chord: 'ctrl+B', label: "tmux prefix — reaches the shell" },
    ],
  },
];

// Two bindings on one key is a silent failure — both handlers fire, in
// mount order, and the symptom is "the shortcut does something weird
// sometimes". Cheap to catch at module load; dev-only so it costs nothing
// in the bundle users get.
if (import.meta.env.DEV) {
  const seen = new Map<string, string>();
  for (const [id, binding] of Object.entries(HOTKEYS)) {
    const clash = seen.get(binding.key);
    if (clash) {
      console.error(
        `[hotkeys] "${binding.key}" is claimed by both ${clash} and ${id} — ` +
          'both handlers will fire. Pick a different key.',
      );
    }
    seen.set(binding.key, id);
  }
}
