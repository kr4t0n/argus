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
    /// A flat (unnested) list whose items carry inline math — render as
    /// marker + assembled Text rows.
    case inlineList([MathListItem])
}

/// One item of a flat list that gets the inline-math treatment.
public struct MathListItem: Equatable, Sendable {
    /// The literal source marker: `-`, `*`, `+`, or `3.` / `3)`.
    public let marker: String
    /// Item content; lazy-continuation lines joined with newlines.
    public let text: String

    public init(marker: String, text: String) {
        self.marker = marker
        self.text = text
    }
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
/// - Inline `$…$` renders in plain paragraphs and FLAT list items
///   (Claude's math bullets are overwhelmingly flat single-level
///   lists — and raw list-item dollars don't just look bad, cmark eats
///   their `_` subscripts as emphasis). Math inside nested lists,
///   headings, quotes, and tables stays raw — those need per-block-type
///   Text assembly that isn't worth it until they actually grate. The
///   web renders math everywhere.
///
/// Bracket delimiters are folded to dollars first (MathDelimiters), so
/// every rule below applies to Codex's `\[…\]`/`\(…\)` too.
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
    public static func split(_ source: String) -> [MathSegment] {
        // Codex writes `\[…\]`/`\(…\)`; fold those into the dollar forms
        // this scanner and InlineMath speak before anything else looks
        // at the text. Segments therefore carry the NORMALIZED source —
        // a span that survives into a `.markdown` segment (math in a
        // heading, a table cell) shows as `$…$` rather than the original
        // brackets, which is what Claude's raw math already looks like
        // in those positions.
        let text = MathDelimiters.normalize(source)
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

        /// Parses a block as a FLAT list: every line is either a
        /// top-level (indent 0) marker line or a lazy continuation of
        /// the previous item. Anything else — indented markers
        /// (nesting), a leading non-marker line — returns nil and the
        /// block stays plain markdown.
        func flatListItems(_ block: [String]) -> [MathListItem]? {
            func marker(_ s: Substring) -> (token: String, content: String)? {
                guard let first = s.first else { return nil }
                if first == "-" || first == "*" || first == "+" {
                    let after = s.dropFirst()
                    guard after.first == " " else { return nil }
                    return (String(first), String(after.dropFirst()))
                }
                if first.isNumber {
                    let digits = s.prefix(while: \.isNumber)
                    let rest = s.dropFirst(digits.count)
                    guard digits.count <= 9, let punct = rest.first,
                          punct == "." || punct == ")",
                          rest.dropFirst().first == " " else { return nil }
                    return (String(digits) + String(punct), String(rest.dropFirst(2)))
                }
                return nil
            }
            var items: [MathListItem] = []
            for line in block {
                let indent = line.prefix(while: { $0 == " " }).count
                let rest = line.drop(while: { $0 == " " })
                if let m = marker(rest) {
                    guard indent == 0 else { return nil } // nested → bail
                    items.append(MathListItem(marker: m.token, text: m.content))
                } else if let last = items.last {
                    items[items.count - 1] = MathListItem(
                        marker: last.marker, text: last.text + "\n" + String(rest))
                } else {
                    return nil
                }
            }
            return items.isEmpty ? nil : items
        }

        /// Emit the buffered markdown, carving out plain paragraphs
        /// and flat lists that carry inline math. Fences are re-tracked
        /// here because the outer loop buffers fence bodies verbatim.
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
                } else if let items = flatListItems(block),
                          items.contains(where: { InlineMath.containsMath($0.text) }) {
                    flushMarkdownRun()
                    segments.append(.inlineList(items))
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
