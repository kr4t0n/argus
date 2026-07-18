import Foundation

/// Port of `apps/web/src/lib/deltaSplit.ts` — keep behavior identical.
///
/// Tool / output / error chunks form natural boundaries between assistant
/// text events. All three CLIs follow the same pattern when tools are
/// involved: interleaved "narration" deltas between tool calls, then the
/// real answer after the last tool. Treating the last text block as the
/// answer and earlier ones as in-flight commentary matches the CLIs' own
/// UX; without the split the body collapses into narration glued to the
/// final reply.
///
/// Algorithm: the boundary is the highest seq among tool / stdout /
/// stderr / error chunks. Deltas at or before it are intermediate; deltas
/// strictly after are the final answer. No tools → boundary -1 → every
/// delta is "final".
public struct DeltaSplit: Equatable, Sendable {
    /// Highest seq of any tool / stdout / stderr / error chunk; -1 when none.
    public let boundarySeq: Int
    /// Deltas (chronological) that form the final assistant answer.
    public let finalDeltas: [ResultChunk]
    /// Deltas (chronological) before the last tool — interim narration.
    public let intermediateDeltas: [ResultChunk]

    public static func split(_ chunks: [ResultChunk]) -> DeltaSplit {
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
        for chunk in chunks where chunk.kind == .delta && !isNested(chunk) {
            if chunk.seq > lastDeltaSeq { lastDeltaSeq = chunk.seq }
        }
        var boundarySeq = -1
        for chunk in chunks where !isNested(chunk) {
            switch chunk.kind {
            case .tool, .stdout, .stderr, .error:
                if chunk.seq > boundarySeq { boundarySeq = chunk.seq }
            case .final:
                if chunk.seq < lastDeltaSeq, chunk.seq > boundarySeq {
                    boundarySeq = chunk.seq
                }
            default:
                break
            }
        }

        var finalDeltas: [ResultChunk] = []
        var intermediateDeltas: [ResultChunk] = []
        for chunk in chunks where chunk.kind == .delta && !isNested(chunk) {
            if chunk.seq > boundarySeq {
                finalDeltas.append(chunk)
            } else {
                intermediateDeltas.append(chunk)
            }
        }
        return DeltaSplit(
            boundarySeq: boundarySeq,
            finalDeltas: finalDeltas,
            intermediateDeltas: intermediateDeltas
        )
    }

    /// Chunks emitted inside a sub-agent (Task) run — stamped with
    /// meta.parentToolUseId — are INVISIBLE to the split: the sub-agent's
    /// tools must not move the boundary, and its streamed text must
    /// never join the parent's answer (it renders inside the sub-agent
    /// card). Without this, a background sub-agent streaming its report
    /// after the parent's last top-level tool put that report INTO the
    /// rendered answer, glued to the parent's real reply.
    private static func isNested(_ chunk: ResultChunk) -> Bool {
        !(chunk.meta?["parentToolUseId"]?.string ?? "").isEmpty
    }
}
