import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { Check, Code2, Copy, Eye } from 'lucide-react';
import { copyTextToClipboard } from '../lib/clipboard';
import { HtmlPreview } from './HtmlPreview';

/**
 * Custom <pre> renderer for ReactMarkdown that overlays a copy button on
 * every code block. The button reads the rendered <pre>'s `innerText` so
 * it works regardless of any inline syntax-highlight markup the markdown
 * pipeline may inject inside the <code>.
 *
 * For ```html``` fenced blocks we additionally surface a Preview toggle
 * that renders the source inside a sandboxed iframe (see HtmlPreview),
 * so users get the rendered page without having to copy-paste it into
 * a separate viewer.
 *
 * The buttons sit in the wrapping div (not the <pre>) so the pre's own
 * `overflow-x-auto` can't scroll them out of view.
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
  // HTML blocks default to the rendered preview; the toggle (and any
  // non-HTML block) still falls back to source. `preview` is inert for
  // non-HTML since the render path is gated on `isHtml` below.
  const [preview, setPreview] = useState(true);

  // react-markdown wraps fenced blocks as <pre><code class="language-xxx">.
  // Walk the immediate children to find that className so we can decide
  // whether the Preview affordance applies.
  const lang = useMemo(() => detectLanguage(children), [children]);
  const isHtml = lang === 'html';
  // Pre-compute the raw source up front so it's available whether the
  // <pre> is currently mounted (source view) or replaced by the iframe
  // (preview view). Walking the React tree also stays in sync with
  // streaming updates, unlike a one-shot innerText snapshot.
  const sourceText = useMemo(() => (isHtml ? extractText(children) : ''), [children, isHtml]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    // Prefer innerText when the <pre> is mounted (preserves any spacing
    // the markdown pipeline rendered). Fall back to the extracted source
    // when we're showing the iframe preview.
    const text = preRef.current?.innerText ?? sourceText;
    if (!text) return;
    const ok = await copyTextToClipboard(text);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [sourceText]);

  return (
    <div className="group/code relative">
      {preview && isHtml ? (
        <div className="overflow-hidden rounded-md border border-default bg-surface-0">
          <HtmlPreview
            content={sourceText}
            name="HTML preview"
            autoHeight
            className="min-h-[3rem]"
          />
        </div>
      ) : (
        <pre ref={preRef} {...rest}>
          {children}
        </pre>
      )}
      <div className="absolute right-2 top-2 flex items-center gap-1">
        {isHtml && (
          <button
            type="button"
            onClick={() => setPreview((v) => !v)}
            aria-label={preview ? 'Show source' : 'Show rendered preview'}
            title={preview ? 'Show source' : 'Show rendered preview'}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-surface-2/70 px-2 text-xs text-fg-muted opacity-0 backdrop-blur-sm transition-opacity hover:bg-surface-2 hover:text-fg-secondary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fg-tertiary group-hover/code:opacity-100 dark:bg-surface-1/70 dark:hover:bg-surface-1"
          >
            {preview ? (
              <>
                <Code2 className="h-3.5 w-3.5" /> Source
              </>
            ) : (
              <>
                <Eye className="h-3.5 w-3.5" /> Preview
              </>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          title={copied ? 'Copied' : 'Copy code'}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-surface-2/70 text-fg-muted opacity-0 backdrop-blur-sm transition-opacity hover:bg-surface-2 hover:text-fg-secondary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fg-tertiary group-hover/code:opacity-100 dark:bg-surface-1/70 dark:hover:bg-surface-1"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-500/80" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

function detectLanguage(children: ReactNode): string | null {
  let lang: string | null = null;
  Children.forEach(children, (child) => {
    if (lang || !isValidElement(child)) return;
    const className = (child.props as { className?: string }).className ?? '';
    const m = /(?:^|\s)language-([\w-]+)/i.exec(className);
    if (m) lang = m[1].toLowerCase();
  });
  return lang;
}

function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return '';
}
