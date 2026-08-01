import Foundation

/// One piece of an assistant answer after math extraction.
public enum MathSegment: Equatable, Sendable {
    /// Ordinary markdown — render with MarkdownUI.
    case markdown(String)
    /// The inside of a `$$…$$` block — render with SwiftMath.
    case displayMath(String)
    /// A plain paragraph carrying inline `$…$` math — render as an
    /// assembled Text with SwiftMath images (see InlineMath.runs).
    case inlineParagraph(String)
}

/// Splits answer markdown into text, `$$…$$` display-math, and
/// inline-math-paragraph segments.
///
/// cmark-gfm (MarkdownUI's parser) has no math extension, so math is
/// extracted BEFORE parsing and rendered natively by the app; the web
/// reaches the same feature through remark-math instead
/// (`apps/web/src/lib/markdown.ts`). Keep the delimiter rules aligned
/// with the web's, with deliberate deviations:
///
/// - A standalone `$$…$$` single line renders as *display* math here but
///   *inline* math on the web (micromark treats it as math-text). Claude
///   emits that shape constantly, and display beats raw dollars.
/// - Inline `$…$` renders ONLY in plain paragraphs. Math inside list
///   items, headings, quotes, and tables stays raw — those blocks would
///   need per-block-type Text assembly to keep their chrome (markers,
///   cells), which isn't worth it until raw dollars there actually
///   grate. The web renders math everywhere.
///
/// Rules, scanned line by line:
/// - A line that is exactly `$$` (after trimming) opens a block; the
///   next exactly-`$$` line closes it. Unclosed at end of text → the
///   would-be opener stays plain markdown, so a *streaming* turn shows
///   raw source until the closing fence arrives, then snaps to math —
///   the same self-correction the web has.
/// - A single line of the form `$$…$$` (non-empty inner, no `$$` inside)
///   is display math on its own.
/// - A blank-line-delimited paragraph whose lines carry no block marker
///   (heading/list/quote/table/indented code) and which contains at
///   least one inline span (per InlineMath's web-parity rules, code
///   spans immune) becomes `.inlineParagraph`.
/// - Anything inside a ``` / ~~~ code fence is never math — a shell
///   block's `$$` (PID) must not mathify. Indented (4-space) code blocks
///   are NOT recognized as fences; a literal `$$` line inside one would
///   mathify. Accepted: CLIs fence code, indented blocks barely occur.
public enum MathSegments {
    public static func split(_ text: String) -> [MathSegment] {
        // Fast path: virtually every answer has no math at all.
        guard text.contains("$") else { return [.markdown(text)] }

        let lines = text.components(separatedBy: "\n")
        var segments: [MathSegment] = []
        var buffer: [String] = []

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

        func isBlank(_ line: String) -> Bool {
            line.trimmingCharacters(in: .whitespaces).isEmpty
        }

        /// Can this line belong to a plain paragraph? Excludes headings,
        /// quotes, table rows, list items, and indented code lines.
        func isPlainParagraphLine(_ line: String) -> Bool {
            let indent = line.prefix(while: { $0 == " " }).count
            guard indent <= 3 else { return false }
            let rest = line.drop(while: { $0 == " " })
            guard let first = rest.first else { return false }
            switch first {
            case "#", ">", "|":
                return false
            case "-", "*", "+":
                // A list marker needs a following space — "*emphasis*"
                // and thematic-break "---" lines stay paragraph-ish.
                return rest.index(after: rest.startIndex) == rest.endIndex
                    || rest[rest.index(after: rest.startIndex)] != " "
            default:
                if first.isNumber {
                    // Ordered-list marker: digits, then "." or ")", then space.
                    let digits = rest.prefix(while: \.isNumber)
                    let after = rest.dropFirst(digits.count)
                    if let punct = after.first, punct == "." || punct == ")",
                       after.dropFirst().first == " " {
                        return false
                    }
                }
                return true
            }
        }

        /// Emit the buffered markdown, carving out plain paragraphs
        /// that carry inline math. Fences are re-tracked here because
        /// the outer loop buffers fence bodies verbatim.
        func flushBuffered() {
            let buffered = buffer
            buffer = []
            var mdRun: [String] = []
            func flushMarkdownRun() {
                // Whitespace-only chunks (blank lines around a math
                // block) would render as stray empty paragraphs — drop
                // them. Blank lines BETWEEN real text stay inside one
                // run, so paragraph breaks are unaffected.
                let joined = mdRun.joined(separator: "\n")
                mdRun = []
                if !joined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    segments.append(.markdown(joined))
                }
            }
            var fence: (char: Character, length: Int)?
            var i = 0
            while i < buffered.count {
                let line = buffered[i]
                if let open = fence {
                    mdRun.append(line)
                    if let marker = fenceMarker(line), marker.char == open.char,
                       marker.length >= open.length,
                       line.trimmingCharacters(in: .whitespaces).allSatisfy({ $0 == open.char }) {
                        fence = nil
                    }
                    i += 1
                    continue
                }
                if let marker = fenceMarker(line) {
                    fence = marker
                    mdRun.append(line)
                    i += 1
                    continue
                }
                if isBlank(line) {
                    mdRun.append(line)
                    i += 1
                    continue
                }
                // Paragraph block: consecutive non-blank, non-fence lines.
                var j = i
                while j < buffered.count, !isBlank(buffered[j]), fenceMarker(buffered[j]) == nil {
                    j += 1
                }
                let block = Array(buffered[i..<j])
                let blockText = block.joined(separator: "\n")
                if block.allSatisfy(isPlainParagraphLine), InlineMath.containsMath(blockText) {
                    flushMarkdownRun()
                    segments.append(.inlineParagraph(blockText))
                } else {
                    mdRun.append(contentsOf: block)
                }
                i = j
            }
            flushMarkdownRun()
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
                    flushBuffered()
                    segments.append(.displayMath(
                        lines[(i + 1)..<close].joined(separator: "\n")
                            .trimmingCharacters(in: .whitespacesAndNewlines)))
                    i = close + 1
                    continue
                }
            } else if trimmed.hasPrefix("$$"), trimmed.hasSuffix("$$"), trimmed.count >= 5 {
                let inner = String(trimmed.dropFirst(2).dropLast(2))
                    .trimmingCharacters(in: .whitespaces)
                // Several `$$a$$ … $$b$$` spans on one line are not ONE
                // display formula — leave them for the inline pass.
                if !inner.isEmpty, !inner.contains("$$") {
                    flushBuffered()
                    segments.append(.displayMath(inner))
                    i += 1
                    continue
                }
            }

            buffer.append(line)
            i += 1
        }
        flushBuffered()
        return segments
    }
}
