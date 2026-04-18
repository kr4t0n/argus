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

export function FileChips({ files }: { files: string[] }) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {files.map((f) => (
        <span
          key={f}
          className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 border border-neutral-800 px-2 py-1 font-mono text-[11px] text-neutral-400"
        >
          <FileText className="h-3 w-3 text-neutral-500" />
          <span className="truncate max-w-[260px]">{f}</span>
        </span>
      ))}
    </div>
  );
}
