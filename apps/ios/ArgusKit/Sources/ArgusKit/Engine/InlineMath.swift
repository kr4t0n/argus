import Foundation

/// One run of an inline-math-bearing paragraph.
public enum InlineMathRun: Equatable, Sendable {
    /// Ordinary inline markdown (may contain bold/italic/code/links).
    case text(String)
    /// The inside of a `$…$` (or mid-paragraph `$$…$$`) span.
    case math(String)
}

/// Splits one paragraph into text and inline-math runs.
///
/// Delimiter semantics mirror the web's remark-math (micromark
/// math-text), which pairs like code spans — any `$` with a matching
/// closer mathifies, including the accepted "$5 and then $10"
/// false positive. Specifically:
/// - `$…$` and mid-paragraph `$$…$$` open a span; the closer must be a
///   dollar run of the SAME length.
/// - Backtick code spans are immune (`` `$PATH` `` stays code), matched
///   by equal-length backtick runs per CommonMark.
/// - `\$` is an escaped literal dollar, never a delimiter.
/// - Empty or whitespace-only spans don't count.
public enum InlineMath {
    public static func runs(_ paragraph: String) -> [InlineMathRun] {
        guard paragraph.contains("$") else { return [.text(paragraph)] }
        var runs: [InlineMathRun] = []
        var textStart = paragraph.startIndex
        var i = paragraph.startIndex

        func charRun(of char: Character, at start: String.Index) -> String.Index {
            var end = start
            while end < paragraph.endIndex, paragraph[end] == char {
                end = paragraph.index(after: end)
            }
            return end
        }

        while i < paragraph.endIndex {
            let char = paragraph[i]
            if char == "\\" {
                // Escape: skip the backslash and whatever follows.
                i = paragraph.index(after: i)
                if i < paragraph.endIndex { i = paragraph.index(after: i) }
                continue
            }
            if char == "`" {
                // Code span: skip to the matching equal-length backtick
                // run; an unmatched opener is literal text.
                let openEnd = charRun(of: "`", at: i)
                let length = paragraph.distance(from: i, to: openEnd)
                var j = openEnd
                var closed = false
                while j < paragraph.endIndex {
                    if paragraph[j] == "`" {
                        let end = charRun(of: "`", at: j)
                        if paragraph.distance(from: j, to: end) == length {
                            i = end
                            closed = true
                            break
                        }
                        j = end
                    } else {
                        j = paragraph.index(after: j)
                    }
                }
                if !closed { i = openEnd }
                continue
            }
            if char == "$" {
                let openEnd = charRun(of: "$", at: i)
                let length = min(paragraph.distance(from: i, to: openEnd), 2)
                let contentStart = paragraph.index(i, offsetBy: length)
                var j = contentStart
                var span: (content: Substring, end: String.Index)?
                while j < paragraph.endIndex {
                    let c = paragraph[j]
                    if c == "\\" {
                        j = paragraph.index(after: j)
                        if j < paragraph.endIndex { j = paragraph.index(after: j) }
                        continue
                    }
                    if c == "$" {
                        let end = charRun(of: "$", at: j)
                        if paragraph.distance(from: j, to: end) == length {
                            span = (paragraph[contentStart..<j], end)
                            break
                        }
                        // Mismatched run: keep scanning, like micromark —
                        // `$a$$b$` closes at the LAST dollar (content a$$b).
                        j = end
                        continue
                    }
                    j = paragraph.index(after: j)
                }
                if let span, !span.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    if textStart < i {
                        runs.append(.text(String(paragraph[textStart..<i])))
                    }
                    runs.append(.math(String(span.content)))
                    i = span.end
                    textStart = i
                } else {
                    i = openEnd
                }
                continue
            }
            i = paragraph.index(after: i)
        }
        if textStart < paragraph.endIndex {
            runs.append(.text(String(paragraph[textStart...])))
        }
        return runs.isEmpty ? [.text(paragraph)] : runs
    }

    /// Whether the paragraph has at least one inline-math span.
    public static func containsMath(_ paragraph: String) -> Bool {
        runs(paragraph).contains { if case .math = $0 { return true } else { return false } }
    }
}
