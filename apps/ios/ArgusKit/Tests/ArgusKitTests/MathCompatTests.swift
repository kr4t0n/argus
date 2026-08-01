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
}
