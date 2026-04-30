import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Code2, Eye, FileWarning, Loader2 } from 'lucide-react';
import type { FSReadResult } from '@argus/shared-types';
import { ApiError, api } from '../lib/api';
import { highlightCode, languageForPath } from '../lib/shiki';
import { useResolvedTheme } from '../lib/theme';
import { useFileTabsStore, type OpenFile } from '../stores/fileTabsStore';
import { cn } from '../lib/utils';

type Props = { file: OpenFile };

/**
 * Top-level viewer for one open file tab. Owns the fetch lifecycle for
 * the file's content (kicks off `GET /agents/:id/fs/read` on mount /
 * tab activation if uncached) and routes by content kind to the right
 * sub-viewer. The fetch result is cached in the file-tabs store so
 * tab-switching back is instant.
 */
export function FileViewer({ file }: Props) {
  useFetchFileContent(file);
  const state = useFileTabsStore((s) => s.contents[file.key]);

  if (!state || state.status === 'loading') {
    return <LoadingViewer />;
  }
  if (state.status === 'error') {
    return <ErrorViewer message={state.message} />;
  }
  return <ContentViewer file={file} result={state.result} />;
}

function useFetchFileContent(file: OpenFile) {
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

function ContentViewer({ file, result }: { file: OpenFile; result: FSReadResult }) {
  if (result.kind === 'text') {
    return <PreviewableTextViewer file={file} content={result.content} />;
  }
  if (result.kind === 'image') {
    return <ImageViewer mime={result.mime} base64={result.base64} name={file.name} />;
  }
  return <BinaryViewer name={file.name} size={result.size} />;
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
function PreviewableTextViewer({ file, content }: { file: OpenFile; content: string }) {
  const previewKind = useMemo<PreviewKind>(() => {
    const lang = languageForPath(file.path);
    if (lang === 'markdown' || lang === 'mdx') return 'markdown';
    if (lang === 'html') return 'html';
    return null;
  }, [file.path]);
  const [showSource, setShowSource] = useState(false);

  if (previewKind === null) {
    return <TextViewer path={file.path} content={content} />;
  }
  return (
    <div className="relative h-full">
      <button
        type="button"
        onClick={() => setShowSource((v) => !v)}
        title={showSource ? 'Show rendered preview' : 'Show source'}
        className="absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-md border border-default bg-surface-0/80 px-2 py-1 text-[11px] text-fg-tertiary backdrop-blur transition-colors hover:border-default-strong hover:text-fg-primary"
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
        <TextViewer path={file.path} content={content} />
      ) : previewKind === 'markdown' ? (
        <div className="markdown h-full overflow-auto px-6 py-5 text-sm leading-relaxed text-fg-primary">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <HtmlPreview content={content} name={file.name} />
      )}
    </div>
  );
}

/**
 * Render an HTML file inside a fully-locked-down iframe. `sandbox=""`
 * (empty value) blocks scripts, forms, top-level navigation, plugins,
 * and pop-ups, and keeps the iframe in a unique origin so it can't
 * touch the parent dashboard's storage / cookies. Inline CSS still
 * applies, so a static page renders the way the author intended; any
 * external resources (CDN scripts, cross-origin images) won't load —
 * that's the trade-off we accept for previewing untrusted content
 * pulled off a remote agent's working tree.
 *
 * Theme handling: a plain HTML page (no body bg, no styles) inherits
 * UA defaults — black text on white. Hard to read on the dashboard's
 * dark theme, and pure-white iframe-bg-on-dark-app is jarring too.
 * We inject a `:root { color-scheme }` style matching the dashboard's
 * resolved theme, so the iframe's UA defaults flip to dark text/bg
 * when the dashboard is dark. Pages that declare their own colors
 * still win — color-scheme only affects UA defaults, not authored CSS.
 */
function HtmlPreview({ content, name }: { content: string; name: string }) {
  const theme = useResolvedTheme();
  const srcDoc = useMemo(() => injectColorScheme(content, theme), [content, theme]);
  return <iframe title={name} srcDoc={srcDoc} sandbox="" className="h-full w-full" />;
}

/**
 * Insert a `<style>:root{color-scheme:…}</style>` into the user's
 * HTML so the iframe's UA defaults follow the dashboard theme. We try
 * to land it inside an existing `<head>`; failing that, after `<html>`;
 * and as a final fallback, wrap the input in a minimal standards-mode
 * document. Wrapping is the right call for body fragments — leaving
 * the input doctype-less would put the iframe in quirks mode.
 */
function injectColorScheme(content: string, theme: 'light' | 'dark'): string {
  const style = `<style>:root{color-scheme:${theme}}</style>`;
  if (/<head\b[^>]*>/i.test(content)) {
    return content.replace(/<head\b[^>]*>/i, (m) => m + style);
  }
  if (/<html\b[^>]*>/i.test(content)) {
    return content.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${style}</head>`);
  }
  return `<!DOCTYPE html><html><head>${style}</head><body>${content}</body></html>`;
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
          'max-w-md rounded-md border border-red-900/50 bg-red-950/20 px-4 py-3',
          'text-sm text-red-300',
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

// Tiny duplicate of FileTree's formatter — pulling that one in would
// drag the whole tree component along with its dependencies.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
