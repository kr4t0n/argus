import Foundation

/// One piece of an assistant answer after display-math extraction.
public enum MathSegment: Equatable, Sendable {
    /// Ordinary markdown — render with MarkdownUI.
    case markdown(String)
    /// The inside of a `$$…$$` block — render with SwiftMath.
    case displayMath(String)
}

/// Splits answer markdown into text and `$$…$$` display-math segments.
///
/// cmark-gfm (MarkdownUI's parser) has no math extension, so `$$` blocks
/// are extracted BEFORE parsing and rendered natively by the app; the
/// web reaches the same feature through remark-math instead
/// (`apps/web/src/lib/markdown.ts`). Keep the delimiter rules aligned
/// with the web's, with two deliberate deviations:
///
/// - A standalone `$$…$$` single line renders as *display* math here but
///   *inline* math on the web (micromark treats it as math-text). Claude
///   emits that shape constantly, and phase 1 has no inline renderer —
///   display beats raw dollars.
/// - Inline `$…$` passes through untouched (renders as plain text until
///   an inline phase lands). The web renders it.
///
/// Rules, scanned line by line:
/// - A line that is exactly `$$` (after trimming) opens a block; the
///   next exactly-`$$` line closes it. Unclosed at end of text → the
///   would-be opener stays plain markdown, so a *streaming* turn shows
///   raw source until the closing fence arrives, then snaps to math —
///   the same self-correction the web has.
/// - A single line of the form `$$…$$` (non-empty inner, no `$$` inside)
///   is display math on its own.
/// - Anything inside a ``` / ~~~ code fence is never math — a shell
///   block's `$$` (PID) must not mathify. Indented (4-space) code blocks
///   are NOT recognized; a literal `$$` line inside one would mathify.
///   Accepted: CLIs fence code, indented blocks barely occur.
public enum MathSegments {
    public static func split(_ text: String) -> [MathSegment] {
        // Fast path: virtually every answer has no math at all.
        guard text.contains("$$") else { return [.markdown(text)] }

        let lines = text.components(separatedBy: "\n")
        var segments: [MathSegment] = []
        var buffer: [String] = []

        func flushMarkdown() {
            // Whitespace-only chunks (the blank lines around a math
            // block) would render as stray empty paragraphs — drop them.
            // Blank lines BETWEEN real text stay inside one buffer, so
            // paragraph breaks are unaffected.
            let joined = buffer.joined(separator: "\n")
            buffer = []
            if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                segments.append(.markdown(joined))
            }
        }

        /// ``` or ~~~ opener (≤3 leading spaces, run of ≥3) → its
        /// (char, run length), else nil.
        func fenceMarker(_ line: String) -> (char: Character, length: Int)? {
            let indent = line.prefix(while: { $0 == " " })
            guard indent.count <= 3 else { return nil }
            let rest = line.dropFirst(indent.count)
            guard let first = rest.first, first == "`" || first == "~" else { return nil }
            let run = rest.prefix(while: { $0 == first }).count
            return run >= 3 ? (first, run) : nil
        }

        var openFence: (char: Character, length: Int)?
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if let fence = openFence {
                buffer.append(line)
                // Closing fence: same char, at least as long, nothing after.
                if let marker = fenceMarker(line), marker.char == fence.char,
                   marker.length >= fence.length,
                   trimmed.allSatisfy({ $0 == fence.char }) {
                    openFence = nil
                }
                i += 1
                continue
            }
            if let marker = fenceMarker(line) {
                openFence = marker
                buffer.append(line)
                i += 1
                continue
            }

            if trimmed == "$$" {
                // Fenced math — only commit once the closer exists.
                if let close = lines[(i + 1)...].firstIndex(where: {
                    $0.trimmingCharacters(in: .whitespaces) == "$$"
                }) {
                    flushMarkdown()
                    segments.append(.displayMath(
                        lines[(i + 1)..<close].joined(separator: "\n")
                            .trimmingCharacters(in: .whitespacesAndNewlines)))
                    i = close + 1
                    continue
                }
            } else if trimmed.hasPrefix("$$"), trimmed.hasSuffix("$$"), trimmed.count >= 5 {
                let inner = String(trimmed.dropFirst(2).dropLast(2))
                    .trimmingCharacters(in: .whitespaces)
                // Several `$$a$$ … $$b$$` spans on one line would fuse
                // into one broken formula — leave that shape raw.
                if !inner.isEmpty, !inner.contains("$$") {
                    flushMarkdown()
                    segments.append(.displayMath(inner))
                    i += 1
                    continue
                }
            }

            buffer.append(line)
            i += 1
        }
        flushMarkdown()
        return segments
    }
}
