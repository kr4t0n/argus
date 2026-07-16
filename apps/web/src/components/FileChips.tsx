import { FileText } from 'lucide-react';
import type { ResultChunkDTO } from '@argus/shared-types';
import { useFileTabsStore } from '../stores/fileTabsStore';

/**
 * Pull file paths out of tool inputs (`file_path`, `path`, `filename`, `files[]`).
 * Returns a deduped list in first-seen order so the UI shows artefacts the
 * agent actually touched, similar to Claude Code / Open Agents file chips.
 */
export function extractFiles(chunks: ResultChunkDTO[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of chunks) {
    if (c.kind !== 'tool') continue;
    const meta = (c.meta ?? {}) as Record<string, unknown>;
    const tool = String(meta.tool ?? '').toLowerCase();
    const input = (meta.input ?? {}) as Record<string, unknown>;
    const candidates: unknown[] = [
      input.file_path,
      input.filePath,
      input.path,
      input.filename,
      input.file,
      ...((input.files as unknown[]) ?? []),
      ...((input.paths as unknown[]) ?? []),
    ];
    for (const v of candidates) {
      if (typeof v !== 'string' || !v) continue;
      // Only count tools that operate on a single file. Skip:
      //   - bash / shell — the `path` is part of a command line
      //   - ls / list_dir / glob / grep — the `path` field is a
      //     directory, and chips are meant to be openable previews
      if (
        tool === 'bash' ||
        tool === 'shell' ||
        tool === 'ls' ||
        tool === 'list_dir' ||
        tool === 'glob' ||
        tool === 'grep'
      ) {
        continue;
      }
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Strip the agent's `workingDir` prefix off an absolute path so the
 * chip shows the part of the path that actually changes between
 * tools (most CLI agents touch files inside their workspace, so the
 * common prefix is pure noise).
 *
 * Falls back to the absolute path when:
 *   - workingDir is unset (no anchor to relativize against)
 *   - the path is already relative (nothing to strip)
 *   - the path is OUTSIDE the workspace (the absolute form is the
 *     useful signal — e.g. an agent reaching into `/etc` or `~`)
 *
 * String compare only — no symlink resolution, no `~` expansion.
 * Adapters give us absolute paths from the host's POV, which is what
 * matters here. The `dir + "/"` boundary check is the gotcha that
 * stops `/work/proj` from matching `/work/projx/file.ts`.
 */
export function displayPath(abs: string, workingDir?: string | null): string {
  if (!workingDir) return abs;
  if (!abs.startsWith('/')) return abs;
  const dir = workingDir.endsWith('/') ? workingDir.slice(0, -1) : workingDir;
  if (abs === dir) return '.';
  if (abs.startsWith(dir + '/')) return abs.slice(dir.length + 1);
  return abs;
}

/**
 * Convert a chip path to the form `api.readProjectFile()` expects (and
 * the sidecar's `fs-read` accepts) — i.e. relative to the agent's
 * `workingDir`, and not a directory.
 *
 * Returns `null` when the path is unopenable:
 *   - file lives outside the workspace (sidecar would reject)
 *   - path looks like a directory (`.`, empty, or trailing slash) —
 *     `extractFiles` already drops the obvious dir-listing tools, but
 *     this guard catches anything that slips through
 */
/**
 * Split a `path:line` / `path:line:col` reference (the form CLI agents
 * use to cite code, e.g. `src/foo.go:123`) into the bare path and the
 * line number. The path part must contain a `.` or `/` to count — that
 * keeps real URI schemes (`tel:123`, `mailto:`) and bare words out,
 * while `http://localhost:3000` is handled by callers re-checking the
 * stripped path against the URL-scheme test. Bare no-extension names
 * (`Makefile:12`) are the accepted miss — indistinguishable from a
 * scheme. Column numbers are parsed but dropped; the viewer scrolls
 * to lines, not columns.
 */
export function splitLineSuffix(path: string): { path: string; line?: number } {
  // Lazy `+?` so `src/foo.go:123:45` splits at the FIRST numeric suffix
  // (line 123, col 45) instead of greedily keeping `:123` in the path.
  const m = /^(.+?):(\d+)(?::\d+)?$/.exec(path);
  if (!m || !/[./]/.test(m[1])) return { path };
  return { path: m[1], line: Number(m[2]) };
}

export function toAgentRelative(path: string, workingDir?: string | null): string | null {
  let rel: string;
  if (path.startsWith('/')) {
    rel = displayPath(path, workingDir);
    if (rel === path) return null;
  } else {
    rel = path;
  }
  if (rel === '' || rel === '.' || rel.endsWith('/')) return null;
  return rel;
}

export function FileChips({
  files,
  workingDir,
  project,
}: {
  files: string[];
  workingDir?: string | null;
  /** When set, double-clicking a chip opens that file in the preview
   *  pane (same store action the file-tabs strip uses). Omitted in
   *  contexts where we don't have an agent to fetch the file from. */
  project?: import('../lib/projects').ProjectRef | null;
}) {
  const openFile = useFileTabsStore((s) => s.openFile);
  if (files.length === 0) return null;
  // Single horizontal row, scroll left/right when chips overflow the
  // container width. `flex-nowrap` keeps chips on the same line;
  // `flex-shrink-0` per chip stops the row from squeezing each one
  // narrower as more pile up; `truncate max-w-[260px]` then bounds
  // any individual long path so a 700-char absolute filename doesn't
  // dominate the whole strip. `no-scrollbar` (defined in index.css)
  // hides the scrollbar in every engine while keeping wheel / trackpad
  // / keyboard scrolling fully functional.
  return (
    <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto no-scrollbar">
      {files.map((f) => {
        const shown = displayPath(f, workingDir);
        const apiPath = project ? toAgentRelative(f, workingDir) : null;
        // A chip is interactive only when we have both an agent AND a
        // path inside the workspace. Files reached via absolute paths
        // outside workingDir would be rejected by the sidecar.
        const interactive = apiPath !== null;
        // Tooltip combines the absolute path (when relativized) with
        // the "double-click to preview" hint, since otherwise the
        // double-click affordance is invisible.
        const titleParts: string[] = [];
        if (shown !== f) titleParts.push(f);
        if (interactive) titleParts.push('Double-click to preview');
        const title = titleParts.length ? titleParts.join('\n') : undefined;
        return (
          <span
            key={f}
            title={title}
            onDoubleClick={
              interactive
                ? () => openFile({ project: project!, path: apiPath! })
                : undefined
            }
            className={
              'inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-surface-1/60 px-2 py-1 font-mono text-xs text-fg-tertiary hover:bg-surface-2/60 hover:text-fg-secondary transition-colors' +
              // `select-none` stops the double-click from highlighting
              // the path text — without it the chip flashes selected
              // every time the user opens a preview.
              (interactive ? ' cursor-pointer select-none' : '')
            }
          >
            <FileText className="h-3 w-3 flex-shrink-0 text-fg-tertiary" />
            <span className="truncate max-w-[260px]">{shown}</span>
          </span>
        );
      })}
    </div>
  );
}
