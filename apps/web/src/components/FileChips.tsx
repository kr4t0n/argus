import { FileText } from 'lucide-react';
import type { ResultChunkDTO } from '@argus/shared-types';

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
      // Skip Bash-like commands; only count tools that operate on files.
      if (tool === 'bash' || tool === 'shell') continue;
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

export function FileChips({
  files,
  workingDir,
}: {
  files: string[];
  workingDir?: string | null;
}) {
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
        return (
          <span
            key={f}
            // Hover reveals the absolute path so copy-out and "where on
            // disk is this exactly?" both keep working when shown != f.
            title={shown === f ? undefined : f}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-surface-1 border border-default px-2 py-1 font-mono text-[11px] text-fg-tertiary"
          >
            <FileText className="h-3 w-3 flex-shrink-0 text-fg-tertiary" />
            <span className="truncate max-w-[260px]">{shown}</span>
          </span>
        );
      })}
    </div>
  );
}
