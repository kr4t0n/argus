import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { renderMermaid } from '../lib/mermaid';
import { useResolvedTheme } from '../lib/theme';

/**
 * Rendered view for a ```mermaid fenced block, used by
 * MarkdownCodeBlock the same way HtmlPreview is used for ```html.
 *
 * Everything here is shaped by the fact that a fence streams in token
 * by token:
 *
 *  - Renders are debounced, because the source changes on every delta
 *    and each intermediate state is invalid anyway.
 *  - A failed parse keeps whatever diagram is already on screen rather
 *    than clearing it, so a settled diagram doesn't flicker back to
 *    source when a later re-render races. Same rule as the FileViewer's
 *    re-highlight path.
 *  - Before anything has parsed, we render `fallback` — the ordinary
 *    <pre> the markdown pipeline would have produced. So a
 *    still-streaming block reads as source and snaps into a diagram
 *    when it completes, and a genuinely malformed one just stays
 *    source. That mirrors how invalid TeX renders as visible source
 *    instead of throwing, and means there is no error state to design.
 */
export function MermaidBlock({ source, fallback }: { source: string; fallback: ReactNode }) {
  const theme = useResolvedTheme();
  // React's useId emits ids like `:r3:`. Mermaid passes the id straight
  // to querySelector, where a leading `:` parses as a pseudo-class and
  // throws — strip them.
  const id = `mermaid-${useId().replace(/:/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    const timer = setTimeout(() => {
      renderMermaid(id, source, theme)
        .then((out) => {
          // Ignore a render that a newer one has already superseded —
          // renders are serialized globally, so they can settle out of
          // order relative to the source that triggered them.
          if (out && seq === seqRef.current) setSvg(out);
        })
        .catch(() => {
          // Layout failure on otherwise-valid syntax. Keep the last
          // good diagram; there's nothing actionable to show.
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [id, source, theme]);

  if (!svg) return <>{fallback}</>;

  return (
    <div
      // Wide diagrams scroll sideways instead of overflowing the
      // transcript column, matching tables and `.katex-display`.
      className="mermaid-host overflow-x-auto rounded-md border border-default bg-surface-0 p-4"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
