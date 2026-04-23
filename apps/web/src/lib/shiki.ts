/**
 * Lazy syntax highlighter wrapping shiki.
 *
 * We deliberately avoid the "load every grammar at boot" path — that
 * ships ~1 MB of grammars before the user has even opened a file.
 * Instead we keep a singleton highlighter with no preloaded languages
 * and call `loadLanguage(name)` on demand, deduping concurrent loads
 * for the same language. The highlighter itself is lazy too — the
 * first preview pays the create cost, subsequent ones don't.
 *
 * The whole module (and its shiki + Oniguruma WASM dependency) is
 * loaded behind a React.lazy boundary on the FileViewer side, so the
 * main app bundle never touches shiki until the user opens a file.
 */
import { createHighlighter, type BundledLanguage, type Highlighter } from 'shiki';

export const SHIKI_THEME = 'github-dark';

let highlighterPromise: Promise<Highlighter> | null = null;
const loaded = new Set<string>();
const loading = new Map<string, Promise<void>>();

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [SHIKI_THEME],
      langs: [],
    });
  }
  return highlighterPromise;
}

async function ensureLanguage(lang: string): Promise<void> {
  if (loaded.has(lang)) return;
  let p = loading.get(lang);
  if (p) return p;
  p = (async () => {
    const h = await getHighlighter();
    try {
      await h.loadLanguage(lang as BundledLanguage);
      loaded.add(lang);
    } finally {
      loading.delete(lang);
    }
  })();
  loading.set(lang, p);
  return p;
}

/**
 * Highlight `code` with the shiki language inferred from `path`.
 * Returns ready-to-inject HTML. Unknown / unsupported extensions
 * render as plain text inside the same shiki wrapper, so the viewer
 * gets a consistent surface either way.
 */
export async function highlightCode(code: string, path: string): Promise<string> {
  const lang = languageForPath(path);
  const target = lang && SUPPORTED.has(lang) ? lang : 'text';
  if (target !== 'text') {
    try {
      await ensureLanguage(target);
    } catch {
      // Grammar load failed (network hiccup, missing bundle) — fall
      // through to plain text rather than blowing up the viewer.
      return renderPlain(code, await getHighlighter());
    }
  }
  const h = await getHighlighter();
  return h.codeToHtml(code, {
    lang: target as BundledLanguage,
    theme: SHIKI_THEME,
  });
}

function renderPlain(code: string, h: Highlighter): string {
  return h.codeToHtml(code, { lang: 'text', theme: SHIKI_THEME });
}

// Map from extension (or full filename for extensionless cases) to a
// shiki built-in language name. Curated rather than exhaustive — we'd
// rather render plain text than ship every grammar shiki has.
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  py: 'python',
  go: 'go',
  rs: 'rust',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'fish',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  sql: 'sql',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cxx: 'cpp',
  cs: 'csharp',
  php: 'php',
  vue: 'vue',
  svelte: 'svelte',
  proto: 'proto',
  ini: 'ini',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
  lua: 'lua',
  // Extensionless conventional names
  Dockerfile: 'dockerfile',
  dockerfile: 'dockerfile',
  Makefile: 'makefile',
  makefile: 'makefile',
};

const SUPPORTED = new Set(Object.values(EXT_TO_LANG));

/** `null` means "no shiki grammar matched" — viewer falls to plain. */
export function languageForPath(path: string): string | null {
  const base = path.split('/').pop() ?? path;
  if (EXT_TO_LANG[base]) return EXT_TO_LANG[base];
  const dot = base.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}
