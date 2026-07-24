import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Code2, Download, Eye, FileWarning, Loader2 } from 'lucide-react';
import type { FSReadResult } from '@argus/shared-types';
import { ApiError, api } from '../lib/api';
import { highlightCode, languageForPath } from '../lib/shiki';
import { useResolvedTheme } from '../lib/theme';
import {
  useFileTabsStore,
  type OpenAttachment,
  type OpenFile,
  type OpenWorkingFile,
} from '../stores/fileTabsStore';
import { cn } from '../lib/utils';
import { HtmlPreview } from './HtmlPreview';

type Props = { file: OpenFile };

/**
 * Top-level viewer for one open file tab. Owns the fetch lifecycle for
 * the file's content (kicks off `GET /projects/:id/fs/read` on mount /
 * tab activation if uncached) and routes by content kind to the right
 * sub-viewer. The fetch result is cached in the file-tabs store so
 * tab-switching back is instant.
 */
export function FileViewer({ file }: Props) {
  if (file.kind === 'attachment') {
    return <AttachmentView file={file} />;
  }
  return <WorkingFileView file={file} />;
}

/** Working-directory file: fetched over fs-read, cached in the tab store. */
function WorkingFileView({ file }: { file: OpenWorkingFile }) {
  useFetchFileContent(file);
  const state = useFileTabsStore((s) => s.contents[file.key]);

  if (!state || state.status === 'loading') {
    return <LoadingViewer />;
  }
  if (state.status === 'error') {
    return <ErrorViewer message={state.message} />;
  }
  return <FileContentView path={file.path} name={file.name} result={state.result} line={file.line} />;
}

function useFetchFileContent(file: OpenWorkingFile) {
  const setContent = useFileTabsStore((s) => s.setContent);
  // Bumped by useFileTabAutoRefresh when a CLI writes into this file's
  // directory. It's in the dep array below, and that is the entire
  // mechanism by which an edited file re-reads itself — the cached
  // content deliberately is NOT, or every fetch would retrigger the
  // effect that performed it.
  const revision = useFileTabsStore((s) => s.revisions[file.key] ?? 0);

  useEffect(() => {
    // Read the cache imperatively: it's a guard, not an input.
    const cached = useFileTabsStore.getState().contents[file.key];
    const hasContent = cached?.status === 'ready';

    // Already holding this exact revision — re-focusing a tab must not
    // re-read the file. The effect re-runs on every activation (the
    // `file.*` deps change), so without this the feature would turn tab
    // switching into fs-read traffic, which is precisely the cost we
    // designed it to avoid.
    if (hasContent && cached.revision === revision) return;

    // Stale-while-revalidate. A cold open shows the spinner; a refresh
    // keeps the current render on screen until the new bytes land.
    // Blanking a file someone is reading every time an agent touches its
    // directory would be a worse bug than the staleness this fixes.
    if (!hasContent && cached?.status !== 'loading') {
      setContent(file.key, { status: 'loading' });
    }

    let cancelled = false;
    api
      .readProjectFile(file.project.projectId, file.path)
      .then((res) => {
        if (cancelled) return;
        setContent(file.key, { status: 'ready', result: res.result, revision });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Don't replace a readable file with a red error box because a
        // refresh lost a race — an atomic write-then-rename leaves a
        // window where the path briefly doesn't resolve. The next nudge
        // (or reopening the tab) recovers. A COLD open still surfaces
        // its error; there's nothing else to show then.
        if (hasContent) return;
        const message =
          err instanceof ApiError ? err.message : (err as Error)?.message || 'failed to load file';
        setContent(file.key, { status: 'error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [file.key, file.project.projectId, file.path, revision, setContent]);
}

/**
 * Routes one already-fetched file's content to the right sub-viewer.
 * Decoupled from the file-tab/fs-read source (takes plain path + name +
 * result) so it can render workingDir files AND HTTP-fetched attachments
 * through the exact same UI. PDF has no fs-read previewable form, so that
 * case is handled separately by AttachmentView, which has the file's URL.
 */
export function FileContentView({
  path,
  name,
  result,
  line,
}: {
  path: string;
  name: string;
  result: FSReadResult;
  /** 1-based line to scroll to / highlight in the source view. */
  line?: number;
}) {
  if (result.kind === 'text') {
    return <PreviewableTextViewer path={path} name={name} content={result.content} line={line} />;
  }
  if (result.kind === 'image') {
    return <ImageViewer mime={result.mime} base64={result.base64} name={name} />;
  }
  return <BinaryViewer name={name} size={result.size} />;
}

type PreviewKind = 'markdown' | 'html' | null;

/**
 * Text files that have a meaningful "rendered" form (markdown, HTML)
 * default to that preview with a "view source" toggle in the corner.
 * Plain code files skip the preview path entirely and go straight to
 * highlighted source.
 *
 * The toggle state lives here (per-tab, ephemeral) — losing it on
 * tab close is fine; it's a viewer affordance, not project state.
 */
function PreviewableTextViewer({
  path,
  name,
  content,
  line,
}: {
  path: string;
  name: string;
  content: string;
  line?: number;
}) {
  const previewKind = useMemo<PreviewKind>(() => {
    const lang = languageForPath(path);
    if (lang === 'markdown' || lang === 'mdx') return 'markdown';
    if (lang === 'html') return 'html';
    return null;
  }, [path]);
  const [showSource, setShowSource] = useState(false);

  if (previewKind === null) {
    return <TextViewer path={path} content={content} line={line} />;
  }
  return (
    <div className="relative h-full">
      <button
        type="button"
        onClick={() => setShowSource((v) => !v)}
        title={showSource ? 'Show rendered preview' : 'Show source'}
        className="absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-md border border-default bg-surface-0/80 px-2 py-1 text-xs text-fg-tertiary backdrop-blur transition-colors hover:border-default-strong hover:text-fg-primary"
      >
        {showSource ? (
          <>
            <Eye className="h-3 w-3" /> Preview
          </>
        ) : (
          <>
            <Code2 className="h-3 w-3" /> Source
          </>
        )}
      </button>
      {showSource ? (
        <TextViewer path={path} content={content} line={line} />
      ) : previewKind === 'markdown' ? (
        <div className="markdown h-full overflow-auto px-6 py-5 text-sm leading-relaxed text-fg-primary">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <HtmlPreview content={content} name={name} />
      )}
    </div>
  );
}

function TextViewer({ path, content, line }: { path: string; content: string; line?: number }) {
  const [html, setHtml] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Scroll offset captured just before a re-highlight, restored once the
  // new markup is in the DOM. Without this, every auto-refresh would
  // yank a reader back to line 1 of the file they're watching.
  const scrollRef = useRef(0);
  // Use the RESOLVED theme (not the user pref) so an OS-driven flip
  // while on 'system' also re-runs the highlight with the matching
  // shiki theme. highlightCode reads `currentShikiTheme()` off
  // <html>, which the apply-theme hook has already updated by the
  // time this effect runs.
  const resolvedTheme = useResolvedTheme();
  // This component is REUSED across tab switches (same tree position,
  // same type), so "the content changed" and "we're looking at a
  // different file now" both arrive as a prop change and have to be told
  // apart.
  const renderedPathRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const samePath = renderedPathRef.current === path;
    renderedPathRef.current = path;
    if (samePath) {
      // Same file, new bytes — an auto-refresh. Capture the scroll BEFORE
      // the swap (`html` still holds the previous markup here, so the
      // host is showing what the user was reading) and deliberately do
      // NOT `setHtml(null)`: dropping to the "highlighting…" spinner on
      // every agent write is exactly the jank this feature must avoid.
      scrollRef.current = hostRef.current?.scrollTop ?? 0;
    } else {
      // Different file. Blank it — leaving the previous file's contents
      // under the new tab's header, then restoring ITS scroll offset,
      // would be straightforwardly wrong.
      scrollRef.current = 0;
      setHtml(null);
    }
    void highlightCode(content, path).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [content, path, resolvedTheme]);

  // Restore scroll in a LAYOUT effect so it lands before paint (no
  // visible jump), and before the citation effect below — which should
  // win when it applies, since an explicit citation beats restoration.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (html === null || !host || scrollRef.current === 0) return;
    host.scrollTop = scrollRef.current;
  }, [html]);

  // Scroll to / highlight the cited line once shiki's html is in the
  // DOM. Runs again when `line` changes (same tab re-opened from a new
  // citation) and clears the previous mark, so at most one line is lit.
  // Keyed by path AND line, not line alone: two different files cited at
  // the same line number are two different scroll targets.
  const scrolledRef = useRef<string | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (html === null || !host) return;
    for (const el of host.querySelectorAll('.line-target')) el.classList.remove('line-target');
    if (!line) {
      scrolledRef.current = null;
      return;
    }
    const target = host.querySelectorAll<HTMLElement>('.line')[line - 1];
    if (!target) return;
    // The marker has to be re-applied on every re-highlight, since shiki
    // rebuilds the DOM — but only SCROLL when the citation itself
    // changed, or an auto-refresh would drag the reader back to the
    // cited line on every agent write.
    target.classList.add('line-target');
    const token = `${path}:${line}`;
    if (scrolledRef.current !== token) {
      scrolledRef.current = token;
      target.scrollIntoView({ block: 'center' });
    }
  }, [html, line, path]);

  if (html === null) {
    return (
      <div className="flex h-full items-center justify-center text-fg-tertiary text-xs">
        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> highlighting…
      </div>
    );
  }
  return (
    <div
      ref={hostRef}
      className="shiki-host h-full overflow-auto"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ImageViewer({ mime, base64, name }: { mime: string; base64: string; name: string }) {
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-surface-0 p-6">
      <img
        src={`data:${mime};base64,${base64}`}
        alt={name}
        className="max-h-full max-w-full rounded border border-default object-contain"
      />
    </div>
  );
}

function BinaryViewer({ name, size }: { name: string; size: number }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-fg-tertiary">
      <FileWarning className="h-8 w-8 text-fg-muted" />
      <div className="text-sm">Cannot preview binary file</div>
      <div className="font-mono text-xs text-fg-muted">
        {name} · {formatBytes(size)}
      </div>
    </div>
  );
}

function ErrorViewer({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div
        className={cn(
          'max-w-md rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/20',
          'text-sm text-red-600 dark:text-red-400',
        )}
      >
        {message}
      </div>
    </div>
  );
}

function LoadingViewer() {
  return (
    <div className="flex h-full items-center justify-center text-fg-tertiary text-xs">
      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> loading…
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Attachment tab: an uploaded file fetched over HTTP rather than fs-read.
// Routes by type — image / PDF render straight from the url, text-like
// files are fetched and handed to the shared FileContentView (same syntax
// highlighting / markdown / HTML preview as a working file), everything
// else falls back to a download panel.
// ─────────────────────────────────────────────────────────────────────

/** Don't slurp a giant file into memory just to syntax-highlight it. */
const TEXT_PREVIEW_MAX = 2_000_000;

const TEXT_EXT =
  /\.(txt|log|csv|tsv|md|markdown|json|ya?ml|xml|html?|css|s[ac]ss|ini|toml|conf|cfg|env|sh|bash|zsh|py|js|jsx|ts|tsx|go|rs|java|kt|c|h|cc|cpp|hpp|rb|php|sql|diff|patch|gradle|dockerfile)$/i;

function isTextLike(mime: string, name: string): boolean {
  return (
    /^text\//i.test(mime) ||
    /^application\/(json|xml|x-yaml|yaml|javascript|ecmascript|x-sh|toml|csv)\b/i.test(mime) ||
    TEXT_EXT.test(name) ||
    languageForPath(name) != null
  );
}

function isPdf(mime: string, name: string): boolean {
  return mime === 'application/pdf' || /\.pdf$/i.test(name);
}

function AttachmentView({ file }: { file: OpenAttachment }) {
  const { url, name, mime, size } = file;
  if (mime.startsWith('image/')) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-surface-0 p-6">
        <img
          src={url}
          alt={name}
          className="max-h-full max-w-full rounded border border-default object-contain"
        />
      </div>
    );
  }
  if (isPdf(mime, name)) {
    return <iframe src={url} title={name} className="h-full w-full border-0 bg-white" />;
  }
  if (isTextLike(mime, name)) {
    if (size > TEXT_PREVIEW_MAX) {
      return (
        <DownloadFallback url={url} name={name} size={size} reason="File is too large to preview here." />
      );
    }
    return <AttachmentTextView url={url} name={name} size={size} />;
  }
  return <DownloadFallback url={url} name={name} size={size} reason="Cannot preview this file type." />;
}

function AttachmentTextView({ url, name, size }: { url: string; name: string; size: number }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; content: string }
    | { status: 'error'; message: string }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`failed to load (HTTP ${r.status})`);
        return r.text();
      })
      .then((content) => {
        if (!cancelled) setState({ status: 'ready', content });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: (e as Error)?.message || 'failed to load' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (state.status === 'loading') return <LoadingViewer />;
  if (state.status === 'error') return <ErrorViewer message={state.message} />;
  const result: FSReadResult = { kind: 'text', content: state.content, size };
  return <FileContentView path={name} name={name} result={result} />;
}

function DownloadFallback({
  url,
  name,
  size,
  reason,
}: {
  url: string;
  name: string;
  size: number;
  reason: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-fg-tertiary">
      <FileWarning className="h-8 w-8 text-fg-muted" />
      <div className="text-sm">{reason}</div>
      <div className="font-mono text-xs text-fg-muted">
        {name} · {formatBytes(size)}
      </div>
      <button
        type="button"
        onClick={() => downloadFile(url, name)}
        className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-default px-3 py-1.5 text-xs text-fg-secondary transition-colors hover:border-default-strong hover:text-fg-primary"
      >
        <Download className="h-3.5 w-3.5" /> Download
      </button>
    </div>
  );
}

/** Force a real download with the right filename. The attachment is served
 *  cross-origin with Content-Disposition: inline, so an `<a download>`
 *  wouldn't rename or force it — fetch the blob and click a local link. */
async function downloadFile(url: string, name: string): Promise<void> {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    window.open(url, '_blank', 'noreferrer');
  }
}

// Tiny duplicate of FileTree's formatter — pulling that one in would
// drag the whole tree component along with its dependencies.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
