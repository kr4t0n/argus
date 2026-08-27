import Foundation

/// Folds LaTeX bracket delimiters into the dollar forms the rest of the
/// math pipeline understands: `\[…\]` → `$$…$$` (display) and `\(…\)` →
/// `$…$` (inline).
///
/// Claude emits dollars; **Codex emits brackets**. A survey of 2232 real
/// Codex answers found 24 display spans (across 11 answers) and 13
/// inline spans (across 6) — rare per-answer, but a hard failure when it
/// lands: `MathSegments` never sees math, so the formula falls through
/// to cmark, which pairs the `_` subscripts inside it as emphasis and
/// eats them. Normalizing here, before any scanning, keeps every
/// downstream stage (display split, inline runs, MathCompat) unchanged.
///
/// Conservative by construction — a span is rewritten only when:
/// - the closer exists, so a half-streamed `\[` stays raw and snaps into
///   math once the closer arrives (the same self-correction `$$` has);
/// - the content is non-blank, holds no `$` (which would collide with
///   the delimiters we emit) and no blank line (which would split the
///   markdown block);
/// - it sits outside ``` / ~~~ fences and outside backtick code spans —
///   a shell `find . \( -name "*.h" \)` inside a fence must not mathify.
///
/// Requiring a *pair* is what protects CommonMark's escaped brackets: a
/// lone `\[` meaning a literal `[` is left alone. All four conditions
/// cost nothing on the surveyed corpus (0 spans carrying `$`, 0 with
/// blank lines, 0 unpaired openers) — insurance, not filters.
///
/// Web counterpart: `normalizeMathDelimiters` in `apps/web/src/lib/
/// markdown.ts`, same rules — keep the two in step.
public enum MathDelimiters {
    public static func normalize(_ text: String) -> String {
        guard text.contains("\\[") || text.contains("\\(") else { return text }

        // Fences are masked line-wise (a fence body may hold anything);
        // spans may cross lines, so each unfenced run is rewritten as
        // one joined region.
        let lines = text.components(separatedBy: "\n")
        var fenced = [Bool](repeating: false, count: lines.count)
        var openFence: (char: Character, length: Int)?
        for (index, line) in lines.enumerated() {
            let marker = fenceMarker(line)
            if let fence = openFence {
                fenced[index] = true
                if let marker, marker.char == fence.char, marker.length >= fence.length,
                   line.trimmingCharacters(in: .whitespaces).allSatisfy({ $0 == fence.char }) {
                    openFence = nil
                }
            } else if let marker {
                openFence = marker
                fenced[index] = true
            }
        }

        var out: [String] = []
        var i = 0
        while i < lines.count {
            if fenced[i] {
                out.append(lines[i])
                i += 1
                continue
            }
            var j = i
            while j < lines.count, !fenced[j] { j += 1 }
            out.append(rewrite(lines[i..<j].joined(separator: "\n")))
            i = j
        }
        return out.joined(separator: "\n")
    }

    /// ``` or ~~~ opener (≤3 leading spaces, run of ≥3) → its
    /// (char, run length), else nil. Mirrors MathSegments' scanner.
    private static func fenceMarker(_ line: String) -> (char: Character, length: Int)? {
        let indent = line.prefix(while: { $0 == " " })
        guard indent.count <= 3 else { return nil }
        let rest = line.dropFirst(indent.count)
        guard let first = rest.first, first == "`" || first == "~" else { return nil }
        let run = rest.prefix(while: { $0 == first }).count
        return run >= 3 ? (first, run) : nil
    }

    /// Rewrite bracket math in one fence-free region. Indexed over a
    /// Character array rather than String.Index: the scan jumps by
    /// two (escape pairs) and backtracks past code spans, and integer
    /// offsets keep that arithmetic obvious.
    private static func rewrite(_ region: String) -> String {
        let chars = Array(region)
        var out = ""
        out.reserveCapacity(chars.count)
        var i = 0
        while i < chars.count {
            let char = chars[i]

            if char == "`" {
                // Code span: copy through to the matching equal-length
                // backtick run, so `` `\(x\)` `` stays code. An
                // unmatched opener is literal text.
                let start = i
                while i < chars.count, chars[i] == "`" { i += 1 }
                let length = i - start
                var j = i
                var closed = false
                while j < chars.count {
                    if chars[j] == "`" {
                        let runStart = j
                        while j < chars.count, chars[j] == "`" { j += 1 }
                        if j - runStart == length {
                            closed = true
                            break
                        }
                    } else {
                        j += 1
                    }
                }
                out += String(chars[start..<(closed ? j : i)])
                if closed { i = j }
                continue
            }

            if char == "\\", i + 1 < chars.count {
                let next = chars[i + 1]
                if next == "[" || next == "(" {
                    let display = next == "["
                    if let end = findCloser(chars, from: i + 2, closer: display ? "]" : ")") {
                        let content = String(chars[(i + 2)..<end])
                        if isRewritable(content) {
                            let delimiter = display ? "$$" : "$"
                            out += delimiter + content + delimiter
                            i = end + 2
                            continue
                        }
                    }
                }
                // Any other escape (`\\`, `\_`, an unpaired `\[`) is verbatim.
                out.append(char)
                out.append(next)
                i += 2
                continue
            }

            out.append(char)
            i += 1
        }
        return out
    }

    /// Offset of the backslash in the next `\<closer>`, honoring `\\`
    /// escape pairs so `\\]` (literal backslash, then `]`) doesn't close
    /// the span. nil when the span never closes.
    private static func findCloser(_ chars: [Character], from: Int, closer: Character) -> Int? {
        var i = from
        while i < chars.count {
            if chars[i] == "\\" {
                if i + 1 < chars.count, chars[i + 1] == closer { return i }
                i += 2
                continue
            }
            i += 1
        }
        return nil
    }

    /// The content guards, shared with the web.
    private static func isRewritable(_ content: String) -> Bool {
        guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        guard !content.contains("$") else { return false }
        // A blank *interior* line would end the markdown block the
        // generated `$$` has to stay inside.
        let lines = content.components(separatedBy: "\n")
        guard lines.count > 2 else { return true }
        return !lines[1..<(lines.count - 1)].contains {
            $0.trimmingCharacters(in: .whitespaces).isEmpty
        }
    }
}
