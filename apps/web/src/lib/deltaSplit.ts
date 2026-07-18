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
  // A command can contain several INNER CLI turns: background sub-agent
  // flows emit a `result` final for the launch-time reply, keep
  // streaming (nested events + the injected completion notification),
  // then emit another final for the follow-up reply. Deltas before an
  // earlier final are that inner turn's text — preamble in the final
  // view, not the command's answer. A final counts as a boundary ONLY
  // when more (non-nested) text follows it: the last final of a normal
  // turn — and the synthetic process-exit final old sidecars emitted
  // right after the rich one — has no deltas after it and must not
  // erase the answer.
  let lastDeltaSeq = -1;
  for (const c of chunks) {
    if (c.kind === 'delta' && !isNested(c) && c.seq > lastDeltaSeq) lastDeltaSeq = c.seq;
  }
  let boundarySeq = -1;
  for (const c of chunks) {
    if (isNested(c)) continue;
    if (c.kind === 'tool' || c.kind === 'stdout' || c.kind === 'stderr' || c.kind === 'error') {
      if (c.seq > boundarySeq) boundarySeq = c.seq;
    }
    if (c.kind === 'final' && c.seq < lastDeltaSeq && c.seq > boundarySeq) {
      boundarySeq = c.seq;
    }
  }
  const finalDeltas: ResultChunkDTO[] = [];
  const intermediateDeltas: ResultChunkDTO[] = [];
  for (const c of chunks) {
    if (c.kind !== 'delta' || isNested(c)) continue;
    if (c.seq > boundarySeq) finalDeltas.push(c);
    else intermediateDeltas.push(c);
  }
  return { boundarySeq, finalDeltas, intermediateDeltas };
}

/**
 * Chunks emitted inside a sub-agent (Task) run — stamped with
 * meta.parentToolUseId — are INVISIBLE to the split: the sub-agent's
 * tools must not move the boundary, and its streamed text must never
 * join the parent's answer (it renders inside the SubAgentWindow card).
 * Without this, a background sub-agent that streams its report after
 * the parent's last top-level tool put that report INTO the rendered
 * answer, glued to the parent's real reply.
 */
function isNested(c: ResultChunkDTO): boolean {
  const pid = (c.meta as Record<string, unknown> | null | undefined)?.parentToolUseId;
  return typeof pid === 'string' && pid.length > 0;
}
