import { useEffect, useMemo, useState } from 'react';
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
 * the file's content (kicks off `GET /agents/:id/fs/read` on mount /
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
  return <FileContentView path={file.path} name={file.name} result={state.result} />;
}

function useFetchFileContent(file: OpenWorkingFile) {
  const setContent = useFileTabsStore((s) => s.setContent);
  const cached = useFileTabsStore((s) => s.contents[file.key]);

  useEffect(() => {
    // Only kick off the fetch if we don't have ANY state for this key
    // yet. Loading / ready / error are all terminal-for-now; a future
    // "reload" action will reset to undefined to re-trigger.
    if (cached) return;
    let cancelled = false;
    setContent(file.key, { status: 'loading' });
    api
      .readAgentFile(file.agentId, file.path)
      .then((res) => {
        if (cancelled) return;
        setContent(file.key, { status: 'ready', result: res.result });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof ApiError ? err.message : (err as Error)?.message || 'failed to load file';
        setContent(file.key, { status: 'error', message });
      });
    return () => {
      cancelled = true;
    };
    // `cached` intentionally omitted — only re-run when the file
    // identity changes; the cache check above already gates the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.key, file.agentId, file.path]);
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
}: {
  path: string;
  name: string;
  result: FSReadResult;
}) {
  if (result.kind === 'text') {
    return <PreviewableTextViewer path={path} name={name} content={result.content} />;
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
}: {
  path: string;
  name: string;
  content: string;
}) {
  const previewKind = useMemo<PreviewKind>(() => {
    const lang = languageForPath(path);
    if (lang === 'markdown' || lang === 'mdx') return 'markdown';
    if (lang === 'html') return 'html';
    return null;
  }, [path]);
  const [showSource, setShowSource] = useState(false);

  if (previewKind === null) {
    return <TextViewer path={path} content={content} />;
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
        <TextViewer path={path} content={content} />
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

function TextViewer({ path, content }: { path: string; content: string }) {
  const [html, setHtml] = useState<string | null>(null);
  // Use the RESOLVED theme (not the user pref) so an OS-driven flip
  // while on 'system' also re-runs the highlight with the matching
  // shiki theme. highlightCode reads `currentShikiTheme()` off
  // <html>, which the apply-theme hook has already updated by the
  // time this effect runs.
  const resolvedTheme = useResolvedTheme();
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    void highlightCode(content, path).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [content, path, resolvedTheme]);

  if (html === null) {
    return (
      <div className="flex h-full items-center justify-center text-fg-tertiary text-xs">
        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> highlighting…
      </div>
    );
  }
  return (
    <div className="shiki-host h-full overflow-auto" dangerouslySetInnerHTML={{ __html: html }} />
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
