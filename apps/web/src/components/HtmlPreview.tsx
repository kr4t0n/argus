import { useEffect, useMemo, useRef, useState } from 'react';
import { useResolvedTheme } from '../lib/theme';
import { cn } from '../lib/utils';

/**
 * Render HTML content inside a sandboxed iframe.
 *
 * Sandbox posture is keyed off `autoHeight`:
 *
 *  - default (`autoHeight=false`, the FileViewer path): `sandbox=""`
 *    (empty value). Unique opaque origin, no scripts, no forms, no
 *    navigation — the strictest setting. Inline CSS still applies, so a
 *    static page renders the way the author intended; external
 *    resources won't load. Sized by its container (`h-full`). File
 *    content off a remote agent's working tree is fully inert here.
 *
 *  - `autoHeight=true` (the chat code-block path): `sandbox=
 *    "allow-scripts"`. JavaScript in the document RUNS, so model-
 *    generated pages can be genuinely interactive (Chart.js and other
 *    CDN-loaded libraries work). Crucially we do NOT add
 *    `allow-same-origin`: the frame gets a unique opaque origin, so its
 *    scripts cannot reach `window.parent`/`top`, the dashboard's
 *    cookies, `localStorage`, or its authenticated APIs. The dangerous
 *    combination is `allow-scripts` + `allow-same-origin` from our own
 *    origin (that escapes the sandbox into the user's session); keeping
 *    same-origin OFF is what makes running untrusted scripts safe.
 *
 *    Because an opaque origin forbids the parent from reading the
 *    iframe's `contentDocument`, auto-height can no longer be measured
 *    from the outside. Instead we inject a tiny bootstrap script that
 *    measures its own `scrollHeight` and `postMessage`s it out; the
 *    parent listens and grows the frame to fit.
 *
 *    Trade-off we accept: scripts can still hit the network (that's how
 *    CDN libs load — the point) and could therefore beacon out. That's
 *    tolerable precisely because the opaque origin holds no privileged
 *    data: there is no session, cookie, or app DOM in the frame to
 *    steal. We deliberately do not inject a no-network CSP, since that
 *    would also block the CDN libraries this path exists to support.
 *
 * Theme handling: a plain HTML page (no body bg, no styles) inherits
 * UA defaults — black text on white. Hard to read on the dashboard's
 * dark theme, and pure-white iframe-bg-on-dark-app is jarring too.
 * We inject a `:root { color-scheme }` style matching the dashboard's
 * resolved theme, so the iframe's UA defaults flip to dark text/bg
 * when the dashboard is dark. Pages that declare their own colors
 * still win — color-scheme only affects UA defaults, not authored CSS.
 */

// Marker for the iframe→parent height channel. The bootstrap posts with
// targetOrigin '*' (the payload is just a number, and the opaque-origin
// frame can't address our origin by name); the parent authenticates by
// `event.source` identity, not origin, and re-validates the shape.
const HEIGHT_MSG = 'argus:html-preview:height';

export function HtmlPreview({
  content,
  name,
  className,
  autoHeight = false,
}: {
  content: string;
  name: string;
  className?: string;
  autoHeight?: boolean;
}) {
  const theme = useResolvedTheme();
  const srcDoc = useMemo(
    () => prepareDocument(content, theme, autoHeight),
    [content, theme, autoHeight],
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!autoHeight) return;
    const onMessage = (e: MessageEvent) => {
      // Only trust messages from *this* iframe's window. The sandbox is
      // an opaque origin, so e.origin is "null" — identity, not origin,
      // is the check that matters here.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as { type?: unknown; value?: unknown } | null;
      if (!data || data.type !== HEIGHT_MSG) return;
      const next = Number(data.value);
      if (!Number.isFinite(next) || next <= 0) return;
      // Guard the ResizeObserver feedback loop: only commit a real change.
      setHeight((prev) => (prev != null && Math.abs(prev - next) <= 1 ? prev : next));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [autoHeight]);

  return (
    <iframe
      ref={iframeRef}
      title={name}
      srcDoc={srcDoc}
      sandbox={autoHeight ? 'allow-scripts' : ''}
      className={cn(autoHeight ? 'block w-full border-0' : 'h-full w-full', className)}
      style={autoHeight && height != null ? { height } : undefined}
    />
  );
}

// Self-measuring height reporter injected into the chat-path frame.
// Runs under `allow-scripts` (opaque origin); re-reports on load and on
// any reflow (<details> toggles, a chart finishing layout, fonts
// settling, streaming re-renders) so the parent can keep the frame
// sized to its content.
const HEIGHT_BOOTSTRAP = `<script>(function(){
function post(){
var d=document;
var h=Math.max(d.documentElement?d.documentElement.scrollHeight:0,d.body?d.body.scrollHeight:0);
if(h>0)parent.postMessage({type:'${HEIGHT_MSG}',value:h},'*');
}
try{if(typeof ResizeObserver!=='undefined'&&document.documentElement){
new ResizeObserver(post).observe(document.documentElement);}}catch(e){}
window.addEventListener('load',post);
document.addEventListener('DOMContentLoaded',post);
post();
})();</script>`;

/**
 * Insert the theme `color-scheme` style — and, for the chat path, the
 * height-reporting bootstrap — into the user's HTML. We try to land the
 * injection inside an existing `<head>`; failing that, after `<html>`;
 * and as a final fallback, wrap the input in a minimal standards-mode
 * document. Wrapping is the right call for body fragments — leaving the
 * input doctype-less would put the iframe in quirks mode.
 */
function prepareDocument(
  content: string,
  theme: 'light' | 'dark',
  withBootstrap: boolean,
): string {
  const head = `<style>:root{color-scheme:${theme}}</style>${withBootstrap ? HEIGHT_BOOTSTRAP : ''}`;
  if (/<head\b[^>]*>/i.test(content)) {
    return content.replace(/<head\b[^>]*>/i, (m) => m + head);
  }
  if (/<html\b[^>]*>/i.test(content)) {
    return content.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  }
  return `<!DOCTYPE html><html><head>${head}</head><body>${content}</body></html>`;
}
