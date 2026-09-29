package app.argus.core.engine

import app.argus.core.model.ResultChunk
import app.argus.core.model.ResultKind
import app.argus.core.model.asString

// Port of apps/ios/ArgusKit/Sources/ArgusKit/Engine/DeltaSplit.swift, which
// is itself a port of apps/web/src/lib/deltaSplit.ts — keep behavior
// identical across all of them (the server's `answerPreview` in
// push.service.ts is the fourth copy; change one, change all).

/**
 * Tool / output / error chunks form natural boundaries between assistant
 * text events. All three CLIs follow the same pattern when tools are
 * involved: interleaved "narration" deltas between tool calls, then the
 * real answer after the last tool. Treating the last text block as the
 * answer and earlier ones as in-flight commentary matches the CLIs' own
 * UX; without the split the body collapses into narration glued to the
 * final reply.
 *
 * Algorithm: the boundary is the highest seq among tool / stdout /
 * stderr / error chunks. Deltas at or before it are intermediate; deltas
 * strictly after are the final answer. No tools → boundary -1 → every
 * delta is "final".
 */
data class DeltaSplit(
    /** Highest seq of any tool / stdout / stderr / error chunk; -1 when none. */
    val boundarySeq: Int,
    /** Deltas (chronological) that form the final assistant answer. */
    val finalDeltas: List<ResultChunk>,
    /** Deltas (chronological) before the last tool — interim narration. */
    val intermediateDeltas: List<ResultChunk>,
) {
    companion object {
        fun split(chunks: List<ResultChunk>): DeltaSplit {
            // A command can contain several INNER CLI turns: background
            // sub-agent flows emit a `result` final for the launch-time
            // reply, keep streaming, then emit another final for the
            // follow-up reply. Deltas before an earlier final are that
            // inner turn's text — preamble, not the command's answer. A
            // final counts as a boundary ONLY when more (non-nested) text
            // follows it: the last final of a normal turn — and the
            // synthetic process-exit final old sidecars emitted right
            // after the rich one — has no deltas after it and must not
            // erase the answer.
            var lastDeltaSeq = -1
            for (chunk in chunks) {
                if (chunk.kind == ResultKind.DELTA && !isNested(chunk) && chunk.seq > lastDeltaSeq) {
                    lastDeltaSeq = chunk.seq
                }
            }
            var boundarySeq = -1
            for (chunk in chunks) {
                if (isNested(chunk)) continue
                when (chunk.kind) {
                    ResultKind.TOOL, ResultKind.STDOUT, ResultKind.STDERR, ResultKind.ERROR -> {
                        if (chunk.seq > boundarySeq) boundarySeq = chunk.seq
                    }
                    ResultKind.FINAL -> {
                        if (chunk.seq < lastDeltaSeq && chunk.seq > boundarySeq) {
                            boundarySeq = chunk.seq
                        }
                    }
                    ResultKind.PROGRESS -> {
                        // A background sub-agent's completion notification
                        // resumes the conversation (the CLI injects it as a
                        // user message): the model's next text answers IT. On
                        // the real wire this is the ONLY separator between the
                        // launch-time reply and the follow-up — the inner
                        // `result` finals all flush at process exit, after
                        // every delta.
                        if (chunk.meta?.get("contentType")?.asString == "task_notification" &&
                            chunk.seq > boundarySeq
                        ) {
                            boundarySeq = chunk.seq
                        }
                    }
                    ResultKind.DELTA, ResultKind.UNKNOWN -> Unit
                }
            }

            val finalDeltas = ArrayList<ResultChunk>()
            val intermediateDeltas = ArrayList<ResultChunk>()
            for (chunk in chunks) {
                if (chunk.kind != ResultKind.DELTA || isNested(chunk)) continue
                if (chunk.seq > boundarySeq) {
                    finalDeltas.add(chunk)
                } else {
                    intermediateDeltas.add(chunk)
                }
            }
            return DeltaSplit(
                boundarySeq = boundarySeq,
                finalDeltas = finalDeltas,
                intermediateDeltas = intermediateDeltas,
            )
        }

        /**
         * Chunks emitted inside a sub-agent (Task) run — stamped with
         * meta.parentToolUseId — are INVISIBLE to the split: the sub-agent's
         * tools must not move the boundary, and its streamed text must
         * never join the parent's answer (it renders inside the sub-agent
         * card). Without this, a background sub-agent streaming its report
         * after the parent's last top-level tool put that report INTO the
         * rendered answer, glued to the parent's real reply.
         */
        private fun isNested(chunk: ResultChunk): Boolean =
            !(chunk.meta?.get("parentToolUseId")?.asString ?: "").isEmpty()
    }
}
