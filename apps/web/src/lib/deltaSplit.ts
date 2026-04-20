import type { ResultChunkDTO } from '@argus/shared-types';

/**
 * Tool / output / error chunks form natural boundaries between assistant
 * text events. cursor-cli, claude-code, and (less obviously) codex all
 * follow the same pattern when tools are involved:
 *
 *   delta "let me check X"   ← intermediate thought
 *   tool   ...
 *   stdout ...
 *   delta "now Y"            ← intermediate thought
 *   tool   ...
 *   stdout ...
 *   delta "Done. Result is…" ← THE final answer
 *   final  (concat fallback)
 *
 * Treating the last assistant text block as the "real" answer and the
 * earlier ones as in-flight commentary matches both Cursor and Claude
 * Code's native UX. Without this split, the body collapses into a
 * confusing jumble of running narration glued to the final reply.
 *
 * Algorithm: find the highest seq among non-text non-progress chunks
 * (i.e. tool / stdout / stderr / error). Deltas at or before that seq
 * are intermediate; deltas strictly after are the final answer. When
 * there are no tools at all (a plain Q&A turn), the boundary is -1 and
 * every delta naturally falls into the "final" bucket — single delta
 * groups concatenate cleanly back into the canonical body.
 */
export function splitDeltas(chunks: ResultChunkDTO[]): {
  /** Highest seq of any tool / stdout / stderr / error chunk. -1 when none. */
  boundarySeq: number;
  /** Deltas (chronological) that are part of the final assistant answer. */
  finalDeltas: ResultChunkDTO[];
  /** Deltas (chronological) that occurred before the last tool — interim narration. */
  intermediateDeltas: ResultChunkDTO[];
} {
  let boundarySeq = -1;
  for (const c of chunks) {
    if (c.kind === 'tool' || c.kind === 'stdout' || c.kind === 'stderr' || c.kind === 'error') {
      if (c.seq > boundarySeq) boundarySeq = c.seq;
    }
  }
  const finalDeltas: ResultChunkDTO[] = [];
  const intermediateDeltas: ResultChunkDTO[] = [];
  for (const c of chunks) {
    if (c.kind !== 'delta') continue;
    if (c.seq > boundarySeq) finalDeltas.push(c);
    else intermediateDeltas.push(c);
  }
  return { boundarySeq, finalDeltas, intermediateDeltas };
}
