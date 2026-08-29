import Foundation

/// Rewrites model-flavored LaTeX into SwiftMath 1.7.3's TeX subset.
///
/// KaTeX (the web renderer) accepts far more than SwiftMath, and Claude
/// leans on exactly the commands SwiftMath 1.7.3 lacks — `\big[` sizing
/// and `\operatorname{…}` appear in nearly every RL formula, and either
/// one fails the whole parse, dumping the equation into MathBlock's
/// raw-source fallback. The commands rewritten here are purely
/// presentational, so dropping/mapping them loses only delimiter
/// growth, never content. (SwiftMath gained `\big`/`\operatorname` on
/// `main` after 1.7.3 — when the pin moves past a release containing
/// them, this shim goes redundant-but-harmless.)
///
/// Rewrites:
/// - `\big \Big \bigg \Bigg` (+ `l`/`r`/`m` variants) → dropped, the
///   delimiter that follows stays. Tokenized on letter runs, so real
///   commands that merely start with "big" (`\bigcap`, `\bigoplus`, …)
///   are untouched.
/// - `\operatorname{f}` / `\operatorname*{f}` → `\mathrm{f}`
///   (limits-placement nuance dropped, upright rendering kept).
/// - `\dots` → `\ldots`, `\lVert`/`\rVert` → `\Vert`.
/// - **Under/over annotations → `\atop` stacks** (see `stacked`):
///   `\underbrace{X}_{Y}` → `{\underline{X} \atop Y}`,
///   `\overbrace{X}^{Y}` → `{Y \atop \overline{X}}`,
///   `\underset{Y}{X}` → `{X \atop Y}`, `\overset{Y}{X}` → `{Y \atop X}`.
///   These four are the only unsupported commands that showed up in a
///   scan of the real transcript corpus, and both offending formulas
///   used nothing else outside the subset — so rewriting them is the
///   difference between a rendered equation and a wall of raw source.
///   `\atop` is SwiftMath's bare (bar-less) fraction and is exactly
///   "numerator centered over denominator"; its own serializer emits
///   `{a \atop b}`, so the form round-trips. The curly brace becomes a
///   straight rule — the label, which is real content, survives.
///
/// Anything else passes through verbatim; formulas that still fail to
/// parse (`\substack`, `\boxed`, …) keep hitting the visible fallback
/// rather than being mangled here.
public enum MathCompat {
    private static let delimiterSizes: Set<String> = [
        "big", "bigl", "bigr", "bigm",
        "Big", "Bigl", "Bigr", "Bigm",
        "bigg", "biggl", "biggr", "biggm",
        "Bigg", "Biggl", "Biggr", "Biggm",
    ]

    public static func swiftMathLatex(_ latex: String) -> String {
        guard latex.contains("\\") else { return latex }
        var out = ""
        out.reserveCapacity(latex.count)
        var i = latex.startIndex
        while i < latex.endIndex {
            let char = latex[i]
            guard char == "\\" else {
                out.append(char)
                i = latex.index(after: i)
                continue
            }
            let next = latex.index(after: i)
            guard next < latex.endIndex else {
                out.append(char)
                break
            }
            guard latex[next].isLetter else {
                // Single-char command (`\,` `\{` `\\` …) — pass through.
                out.append(char)
                out.append(latex[next])
                i = latex.index(after: next)
                continue
            }
            var end = next
            while end < latex.endIndex, latex[end].isLetter {
                end = latex.index(after: end)
            }
            let command = String(latex[next..<end])
            i = end
            switch command {
            case _ where delimiterSizes.contains(command):
                break // drop the size prefix, keep the delimiter after it
            case "operatorname":
                out += "\\mathrm"
                if end < latex.endIndex, latex[end] == "*" {
                    i = latex.index(after: end)
                }
            case "dots":
                out += "\\ldots"
            case "lVert", "rVert":
                out += "\\Vert"
            case "underbrace", "overbrace", "underset", "overset":
                // Needs its argument groups, so it consumes past `i`.
                // If the groups don't parse (unbalanced mid-stream), emit
                // the command untouched and let the parse fail visibly —
                // the pre-existing behavior, never a mangled formula.
                if let stack = stacked(command, in: latex, from: i) {
                    out += stack.text
                    i = stack.end
                } else {
                    out += "\\" + command
                }
            default:
                out += "\\" + command
            }
        }
        return out
    }

    /// Rewrites one under/over annotation into an `\atop` stack, starting
    /// just past the command name. Returns the replacement and the index
    /// to resume from, or nil when the expected groups aren't there.
    ///
    /// Arguments are rewritten recursively, so a `\big[` or a nested
    /// annotation inside the base or the label is handled too. Recursion
    /// terminates because each group is strictly shorter than its input.
    private static func stacked(
        _ command: String, in latex: String, from start: String.Index
    ) -> (text: String, end: String.Index)? {
        guard let first = readGroup(latex, at: skipSpaces(latex, start)) else { return nil }

        // `\underset{below}{base}` / `\overset{above}{base}` — annotation
        // first, base second. No rule is drawn for these.
        if command == "underset" || command == "overset" {
            guard let second = readGroup(latex, at: skipSpaces(latex, first.end)) else { return nil }
            let annotation = swiftMathLatex(first.inner)
            let base = swiftMathLatex(second.inner)
            return (
                command == "underset"
                    ? "{\(base) \\atop \(annotation)}"
                    : "{\(annotation) \\atop \(base)}",
                second.end
            )
        }

        // `\underbrace{X}_{Y}` / `\overbrace{X}^{Y}` — the label is
        // optional, and the brace degrades to a rule on the base.
        let isUnder = command == "underbrace"
        let ruled = "\\\(isUnder ? "underline" : "overline"){\(swiftMathLatex(first.inner))}"
        let marker: Character = isUnder ? "_" : "^"
        let afterBase = skipSpaces(latex, first.end)
        if afterBase < latex.endIndex, latex[afterBase] == marker,
           let label = readGroup(latex, at: skipSpaces(latex, latex.index(after: afterBase))) {
            let annotation = swiftMathLatex(label.inner)
            return (
                isUnder ? "{\(ruled) \\atop \(annotation)}" : "{\(annotation) \\atop \(ruled)}",
                label.end
            )
        }
        return (ruled, first.end)
    }

    private static func skipSpaces(_ latex: String, _ from: String.Index) -> String.Index {
        var i = from
        while i < latex.endIndex, latex[i] == " " || latex[i] == "\n" || latex[i] == "\t" {
            i = latex.index(after: i)
        }
        return i
    }

    /// Reads a balanced `{…}` at `start`, honoring `\{` escapes. Returns
    /// the inner text and the index just past the closing brace; nil if
    /// `start` isn't a brace or the group never closes.
    private static func readGroup(
        _ latex: String, at start: String.Index
    ) -> (inner: String, end: String.Index)? {
        guard start < latex.endIndex, latex[start] == "{" else { return nil }
        var depth = 0
        var i = start
        while i < latex.endIndex {
            let char = latex[i]
            if char == "\\" {
                i = latex.index(after: i)
                if i < latex.endIndex { i = latex.index(after: i) }
                continue
            }
            if char == "{" { depth += 1 }
            if char == "}" {
                depth -= 1
                if depth == 0 {
                    return (String(latex[latex.index(after: start)..<i]), latex.index(after: i))
                }
            }
            i = latex.index(after: i)
        }
        return nil
    }
}
