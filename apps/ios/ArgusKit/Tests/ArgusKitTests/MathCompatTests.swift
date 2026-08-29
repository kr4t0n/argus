import Testing
@testable import ArgusKit

@Suite("MathCompat — LaTeX → SwiftMath 1.7.3 subset rewrites")
struct MathCompatTests {
    @Test("\\big family is stripped, delimiters stay")
    func bigFamily() {
        #expect(MathCompat.swiftMathLatex("\\big[R(y)\\big]") == "[R(y)]")
        #expect(MathCompat.swiftMathLatex("\\Bigg(\\frac{a}{b}\\Bigg)") == "(\\frac{a}{b})")
        #expect(MathCompat.swiftMathLatex("\\bigl\\{ x \\bigr\\}") == "\\{ x \\}")
        #expect(MathCompat.swiftMathLatex("\\bigm| y") == "| y")
    }

    @Test("commands that merely start with 'big' are untouched")
    func bigOperatorsUntouched() {
        #expect(MathCompat.swiftMathLatex("\\bigcap_{i} A_i") == "\\bigcap_{i} A_i")
        #expect(MathCompat.swiftMathLatex("\\bigoplus \\bigcup \\bigwedge")
            == "\\bigoplus \\bigcup \\bigwedge")
    }

    @Test("\\operatorname and \\operatorname* become \\mathrm")
    func operatorname() {
        #expect(MathCompat.swiftMathLatex("\\operatorname{supp}(\\pi_{\\theta_0})")
            == "\\mathrm{supp}(\\pi_{\\theta_0})")
        #expect(MathCompat.swiftMathLatex("\\operatorname*{arg\\,max}_\\theta")
            == "\\mathrm{arg\\,max}_\\theta")
    }

    @Test("\\dots → \\ldots; longer commands unaffected")
    func dots() {
        #expect(MathCompat.swiftMathLatex("a, \\dots, z") == "a, \\ldots, z")
        #expect(MathCompat.swiftMathLatex("\\dotsb") == "\\dotsb")
    }

    @Test("\\lVert/\\rVert → \\Vert")
    func vert() {
        #expect(MathCompat.swiftMathLatex("\\lVert x \\rVert_2") == "\\Vert x \\Vert_2")
    }

    @Test("single-char commands and row breaks pass through")
    func singleCharCommands() {
        #expect(MathCompat.swiftMathLatex("-\\,\\mathbb{E}") == "-\\,\\mathbb{E}")
        #expect(MathCompat.swiftMathLatex("a \\\\ b") == "a \\\\ b")
        #expect(MathCompat.swiftMathLatex("1\\{R=1\\}") == "1\\{R=1\\}")
    }

    @Test("supported formulas come back verbatim")
    func passthrough() {
        let latex = "\\mathcal{L}_{\\text{RFT}}(\\theta) = -\\,\\mathbb{E}_{x}\\,"
            + "\\mathbb{E}_{y\\sim \\pi_{\\theta_0}}"
        #expect(MathCompat.swiftMathLatex(latex) == latex)
    }

    @Test("trailing lone backslash does not crash")
    func trailingBackslash() {
        #expect(MathCompat.swiftMathLatex("x\\") == "x\\")
    }

    @Test("the reported bug: \\underbrace{X}_{Y} becomes an \\atop stack")
    func underbrace() {
        let source = "\\underbrace{\\pi_{\\theta_T}(a\\mid x)}_{\\text{frozen teacher}}"
        #expect(MathCompat.swiftMathLatex(source)
            == "{\\underline{\\pi_{\\theta_T}(a\\mid x)} \\atop \\text{frozen teacher}}")
    }

    @Test("\\overbrace puts the label on top, over an \\overline base")
    func overbrace() {
        #expect(MathCompat.swiftMathLatex("\\overbrace{a+b}^{n}")
            == "{n \\atop \\overline{a+b}}")
    }

    @Test("an unlabelled brace degrades to the bare rule")
    func braceWithoutLabel() {
        #expect(MathCompat.swiftMathLatex("\\underbrace{x}") == "\\underline{x}")
        #expect(MathCompat.swiftMathLatex("\\overbrace{x}") == "\\overline{x}")
    }

    @Test("\\underset/\\overset take annotation-first, base-second")
    func setCommands() {
        #expect(MathCompat.swiftMathLatex("\\underset{y}{\\arg\\max}")
            == "{\\arg\\max \\atop y}")
        #expect(MathCompat.swiftMathLatex("\\overset{def}{=}") == "{def \\atop =}")
    }

    @Test("arguments are rewritten recursively, and \\{ escapes survive")
    func recursiveArguments() {
        #expect(MathCompat.swiftMathLatex("\\underbrace{\\big[x\\big]}_{\\operatorname{tag}}")
            == "{\\underline{[x]} \\atop \\mathrm{tag}}")
        #expect(MathCompat.swiftMathLatex("\\underbrace{x_{\\{a\\}}}_{y}")
            == "{\\underline{x_{\\{a\\}}} \\atop y}")
    }

    @Test("an unbalanced group (mid-stream) is left untouched, never mangled")
    func unbalancedGroup() {
        #expect(MathCompat.swiftMathLatex("\\underbrace{a") == "\\underbrace{a")
        #expect(MathCompat.swiftMathLatex("\\underset{y}") == "\\underset{y}")
    }
}
