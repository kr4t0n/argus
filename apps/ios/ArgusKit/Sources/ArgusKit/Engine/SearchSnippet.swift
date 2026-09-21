import Foundation

/// Splits a `GET /search/sessions` snippet into plain and highlighted
/// runs — the port of `renderSnippet` in the web's `CommandPalette.tsx`.
///
/// The server wraps matched terms in `[[hl]]` / `[[/hl]]` sentinels
/// rather than HTML (`SEARCH_HL_START` / `SEARCH_HL_STOP` in
/// shared-types, duplicated in the server's SearchService): transcript
/// text is model- and user-authored and must never reach an HTML sink,
/// so every client splits on the sentinels and builds native text runs.
/// Change the constants in all three places or none.
///
/// Unpaired markers are left as literal text rather than swallowing the
/// rest of the snippet. Whitespace is collapsed so a row stays two lines
/// tall regardless of how the doc was laid out.
public enum SearchSnippet {
    public static let highlightStart = "[[hl]]"
    public static let highlightStop = "[[/hl]]"

    public struct Run: Equatable, Sendable {
        public let text: String
        public let highlighted: Bool

        public init(text: String, highlighted: Bool) {
            self.text = text
            self.highlighted = highlighted
        }
    }

    public static func runs(_ snippet: String) -> [Run] {
        let flat = snippet
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        var out: [Run] = []
        var rest = Substring(flat)
        while true {
            guard let start = rest.range(of: highlightStart) else { break }
            guard let stop = rest[start.upperBound...].range(of: highlightStop) else { break }
            if start.lowerBound > rest.startIndex {
                out.append(Run(text: String(rest[rest.startIndex..<start.lowerBound]), highlighted: false))
            }
            let marked = rest[start.upperBound..<stop.lowerBound]
            if !marked.isEmpty {
                out.append(Run(text: String(marked), highlighted: true))
            }
            rest = rest[stop.upperBound...]
        }
        if !rest.isEmpty {
            out.append(Run(text: String(rest), highlighted: false))
        }
        return out
    }
}
