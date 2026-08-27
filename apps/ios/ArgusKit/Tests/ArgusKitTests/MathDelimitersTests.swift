import Testing
@testable import ArgusKit

@Suite("MathDelimiters — Codex bracket math folded to dollar delimiters")
struct MathDelimitersTests {
    @Test("the observed Codex shape: multi-line \\[…\\] becomes a $$ block")
    func displayBlock() {
        let source = "The formulation is:\n\n\\[\nr_\\text{aes}(x)\n\\]\n\nTrain it."
        let want = "The formulation is:\n\n$$\nr_\\text{aes}(x)\n$$\n\nTrain it."
        #expect(MathDelimiters.normalize(source) == want)
    }

    @Test("inline \\(…\\) becomes $…$")
    func inlineSpans() {
        #expect(MathDelimiters.normalize("given \\(x\\) and \\(h\\) here") == "given $x$ and $h$ here")
        #expect(MathDelimiters.normalize("\\(a\\)+\\(b\\)") == "$a$+$b$")
    }

    @Test("underscores inside survive — the whole point of the pass")
    func underscoresSurvive() {
        let source = "\\[R = w_a R_\\text{aes} + w_c R_\\text{leg}\\]"
        #expect(MathDelimiters.normalize(source) == "$$R = w_a R_\\text{aes} + w_c R_\\text{leg}$$")
    }

    @Test("unclosed opener stays raw mid-stream, converts once the closer lands")
    func streaming() {
        #expect(MathDelimiters.normalize("mid stream \\[\nr(x)") == "mid stream \\[\nr(x)")
        #expect(MathDelimiters.normalize("mid stream \\[\nr(x)\n\\]") == "mid stream $$\nr(x)\n$$")
    }

    @Test("a lone escaped bracket (CommonMark) is left alone")
    func escapedBrackets() {
        #expect(MathDelimiters.normalize("a literal \\[ bracket") == "a literal \\[ bracket")
        #expect(MathDelimiters.normalize("a literal \\( paren") == "a literal \\( paren")
        // `\\]` is an escaped backslash then `]` — not a closer.
        #expect(MathDelimiters.normalize("\\\\[not math\\\\]") == "\\\\[not math\\\\]")
    }

    @Test("fenced code is immune — the real `find . \\( … \\)` false positive")
    func fencesImmune() {
        let shell = "```bash\nfind . \\( -name \"*.h\" \\) -print\n```"
        #expect(MathDelimiters.normalize(shell) == shell)
        let tilde = "~~~\n\\[x\\]\n~~~"
        #expect(MathDelimiters.normalize(tilde) == tilde)
        // …and text after the fence closes is still rewritten.
        #expect(MathDelimiters.normalize("```\n\\[a\\]\n```\n\\(b\\)") == "```\n\\[a\\]\n```\n$b$")
    }

    @Test("backtick code spans are immune")
    func codeSpansImmune() {
        #expect(MathDelimiters.normalize("use `\\(x\\)` inline") == "use `\\(x\\)` inline")
        #expect(MathDelimiters.normalize("`a` then \\(x\\)") == "`a` then $x$")
    }

    @Test("empty, dollar-bearing, and blank-line-split spans are skipped")
    func contentGuards() {
        #expect(MathDelimiters.normalize("\\[\\]") == "\\[\\]")
        #expect(MathDelimiters.normalize("\\[   \\]") == "\\[   \\]")
        #expect(MathDelimiters.normalize("\\[a $ b\\]") == "\\[a $ b\\]")
        #expect(MathDelimiters.normalize("\\[a\n\nb\\]") == "\\[a\n\nb\\]")
    }

    @Test("text with no bracket delimiters comes back identical")
    func fastPath() {
        let plain = "plain $x$ and **bold** and a \\_escape\\_"
        #expect(MathDelimiters.normalize(plain) == plain)
    }

    @Test("end to end: MathSegments turns Codex brackets into real segments")
    func endToEnd() {
        let answer = "Intro:\n\n\\[\nE = mc^2\n\\]\n\nand inline \\(x\\) too."
        #expect(MathSegments.split(answer) == [
            // Trailing blank line rides the markdown run, as in MathSegmentsTests.
            .markdown("Intro:\n"),
            .displayMath("E = mc^2"),
            .inlineParagraph("and inline $x$ too."),
        ])
    }
}
