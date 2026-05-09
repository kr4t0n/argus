import { useCallback, useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyTextToClipboard } from '../lib/clipboard';

/**
 * Custom <pre> renderer for ReactMarkdown that overlays a copy button on
 * every code block. The button reads the rendered <pre>'s `innerText` so
 * it works regardless of any inline syntax-highlight markup the markdown
 * pipeline may inject inside the <code>.
 *
 * The button sits in the wrapping div (not the <pre>) so the pre's own
 * `overflow-x-auto` can't scroll it out of view.
 */
type Props = ComponentPropsWithoutRef<'pre'> & {
  // react-markdown passes its HAST node alongside the standard <pre>
  // attributes; destructure it so it isn't spread onto the DOM element
  // (where React would warn about an unknown attribute).
  node?: unknown;
};

export function MarkdownCodeBlock({ children, node: _node, ...rest }: Props) {
  const preRef = useRef<HTMLPreElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    const text = preRef.current?.innerText ?? '';
    if (!text) return;
    const ok = await copyTextToClipboard(text);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }, []);

  return (
    <div className="group/code relative">
      <pre ref={preRef} {...rest}>
        {children}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy code'}
        className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md bg-surface-2/70 text-fg-muted opacity-0 backdrop-blur-sm transition-opacity hover:bg-surface-2 hover:text-fg-secondary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fg-tertiary group-hover/code:opacity-100 dark:bg-surface-1/70 dark:hover:bg-surface-1"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-500/80" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
