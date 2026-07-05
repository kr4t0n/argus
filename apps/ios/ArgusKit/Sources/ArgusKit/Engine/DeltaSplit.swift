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
        var boundarySeq = -1
        for chunk in chunks {
            switch chunk.kind {
            case .tool, .stdout, .stderr, .error:
                if chunk.seq > boundarySeq { boundarySeq = chunk.seq }
            default:
                break
            }
        }

        var finalDeltas: [ResultChunk] = []
        var intermediateDeltas: [ResultChunk] = []
        for chunk in chunks where chunk.kind == .delta {
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
}
