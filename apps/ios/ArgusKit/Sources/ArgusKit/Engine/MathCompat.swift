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
///
/// Anything else passes through verbatim; formulas that still fail to
/// parse (`\substack`, `\overbrace`, …) keep hitting the visible
/// fallback rather than being mangled here.
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
            default:
                out += "\\" + command
            }
        }
        return out
    }
}
