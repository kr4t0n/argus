/**
 * Lazy mermaid renderer, in the same shape as `lib/shiki.ts`: a module
 * singleton behind a dynamic `import()`, so the ~3 MB library (and the
 * per-diagram-type chunks it loads itself) never touches the main
 * bundle until a response actually contains a diagram.
 *
 * We render to an SVG string and inject it, rather than routing through
 * the sandboxed `HtmlPreview` iframe the way ```html blocks do. The
 * iframe path would need mermaid from a CDN — which breaks the
 * air-gapped self-hosted installs the Helm chart targets — or inlining
 * the whole library into every `srcDoc`, re-parsed on each token while
 * the answer streams. Injecting generated markup has precedent here:
 * the FileViewer does exactly this with shiki's output.
 *
 * `securityLevel: 'strict'` is what makes injecting model-generated
 * diagrams acceptable — mermaid runs its output through DOMPurify and
 * disables both HTML labels and click handlers. NEVER relax this to
 * 'loose' for transcript content; that re-enables raw HTML in labels
 * and `click` bindings inside our own origin. The cost of strict is
 * that markdown-ish label syntax renders literally.
 */
import type { Mermaid } from 'mermaid';

/** Instrument Sans, matching tailwind's `font-sans`. Mermaid measures
 *  text to lay out nodes, so a font that doesn't match the dashboard
 *  produces boxes visibly too wide or too tight for their labels. */
const FONT_FAMILY = '"Instrument Sans Variable", ui-sans-serif, system-ui, sans-serif';

let modPromise: Promise<Mermaid> | null = null;
let appliedTheme: 'light' | 'dark' | null = null;

// mermaid's config is a module-level GLOBAL, not a per-render argument,
// so two diagrams rendering concurrently under different themes race on
// it. Every render goes through one chain instead. Diagrams are rare
// and small enough that serializing costs nothing visible.
let queue: Promise<unknown> = Promise.resolve();

function configure(mermaid: Mermaid, theme: 'light' | 'dark') {
  mermaid.initialize({
    // Mermaid otherwise scans the document for `.mermaid` nodes on load
    // and renders them behind React's back.
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'dark' ? 'dark' : 'default',
    fontFamily: FONT_FAMILY,
  });
  appliedTheme = theme;
}

/**
 * Render `src` to an SVG string, or `null` when it doesn't parse.
 *
 * `null` is the expected result far more often than it looks: a fenced
 * block streams in token by token, and every intermediate state of it
 * is invalid syntax. `suppressErrors` turns that from a throw into a
 * falsy result so callers can treat "not a diagram yet" as ordinary
 * flow rather than an error to surface. A diagram that parses can
 * still throw during layout, which stays a rejection.
 *
 * `id` must be a valid CSS identifier — mermaid feeds it straight into
 * a `querySelector`. See MermaidBlock for the `useId()` caveat.
 */
export async function renderMermaid(
  id: string,
  src: string,
  theme: 'light' | 'dark',
): Promise<string | null> {
  const run = queue.then(async () => {
    if (!modPromise) modPromise = import('mermaid').then((m) => m.default);
    const mermaid = await modPromise;
    if (appliedTheme !== theme) configure(mermaid, theme);
    if (!(await mermaid.parse(src, { suppressErrors: true }))) return null;
    const { svg } = await mermaid.render(id, src);
    return svg;
  });
  // Keep the chain alive past a failed render — an unhandled rejection
  // here would wedge every subsequent diagram behind it.
  queue = run.catch(() => undefined);
  return run;
}
