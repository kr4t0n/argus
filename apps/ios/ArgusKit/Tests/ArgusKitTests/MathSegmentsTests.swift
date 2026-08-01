import Testing
@testable import ArgusKit

@Suite("MathSegments — $$ display-math extraction for the transcript")
struct MathSegmentsTests {
    @Test("no dollars → single markdown segment, text untouched")
    func noMathPassthrough() {
        let text = "Just prose, no math anywhere.\n\n- a list\n- of things"
        #expect(MathSegments.split(text) == [.markdown(text)])
    }

    @Test("plain paragraph with inline $…$ becomes .inlineParagraph")
    func inlineParagraph() {
        let text = "Sample $y \\sim \\pi_{\\theta_0}(\\cdot|x)$, keep $R(x,y)\\in\\{0,1\\}$, then SFT:"
        #expect(MathSegments.split(text) == [.inlineParagraph(text)])
    }

    @Test("flat bullet list with math becomes .inlineList")
    func flatListWithMath() {
        let list = "- where $\\pi_\\theta$ is the policy\n- and $R$ the reward"
        #expect(MathSegments.split(list) == [.inlineList([
            MathListItem(marker: "-", text: "where $\\pi_\\theta$ is the policy"),
            MathListItem(marker: "-", text: "and $R$ the reward"),
        ])])
    }

    @Test("ordered list with math keeps its numbering tokens")
    func orderedListWithMath() {
        let list = "1. sample $y$\n2) filter $R$"
        #expect(MathSegments.split(list) == [.inlineList([
            MathListItem(marker: "1.", text: "sample $y$"),
            MathListItem(marker: "2)", text: "filter $R$"),
        ])])
    }

    @Test("the on-device regression: bold + math inside a bullet")
    func boldMathBullet() {
        let list = "- **On-policy REINFORCE** (binary reward): "
            + "$\\mathbb{E}_{y\\sim\\pi_\\theta}[R(y)\\nabla_\\theta \\log \\pi_\\theta(y)]$"
        let segments = MathSegments.split(list)
        guard case .inlineList(let items)? = segments.first, segments.count == 1 else {
            Issue.record("expected one .inlineList, got \(segments)")
            return
        }
        #expect(items.count == 1)
        // Underscores must survive verbatim — cmark ate them when this
        // block fell through to MarkdownUI.
        #expect(items[0].text.contains("\\mathbb{E}_{y\\sim\\pi_\\theta}"))
    }

    @Test("lazy continuation lines join into the item")
    func listContinuation() {
        let list = "- first line with $x$\n  continues here"
        #expect(MathSegments.split(list) == [.inlineList([
            MathListItem(marker: "-", text: "first line with $x$\ncontinues here"),
        ])])
    }

    @Test("lists without math, nested lists, and headings stay raw markdown")
    func listScopeLimits() {
        let plain = "- no math here\n- none here either"
        #expect(MathSegments.split(plain + " $ ") == [.markdown(plain + " $ ")])
        let nested = "- outer $x$\n  - inner $y$"
        #expect(MathSegments.split(nested) == [.markdown(nested)])
        let heading = "## About $\\pi_\\theta$"
        #expect(MathSegments.split(heading) == [.markdown(heading)])
    }

    @Test("dollars only inside backtick code spans stay markdown")
    func inlineCodeSpanImmune() {
        let text = "Use `$PATH` and `$HOME` here."
        #expect(MathSegments.split(text) == [.markdown(text)])
    }

    @Test("mixed answer: text, inline paragraph, display block")
    func mixedSegments() {
        let text = "Intro line.\n\nWith $x$ inline.\n\n$$\ny = x^2\n$$"
        #expect(MathSegments.split(text) == [
            .markdown("Intro line.\n"),
            .inlineParagraph("With $x$ inline."),
            .displayMath("y = x^2"),
        ])
    }

    @Test("fenced $$ block splits into text/math/text")
    func fencedBlock() {
        let text = """
        Before.

        $$
        \\nabla J = \\mathbb{E}_{y\\sim\\pi_{\\theta_0}}\\big[R(y)\\big]
        $$

        After.
        """
        let segments = MathSegments.split(text)
        #expect(segments == [
            .markdown("Before.\n"),
            .displayMath("\\nabla J = \\mathbb{E}_{y\\sim\\pi_{\\theta_0}}\\big[R(y)\\big]"),
            .markdown("\nAfter."),
        ])
    }

    @Test("single-line $$…$$ is display math (iOS deviation from web, by design)")
    func singleLine() {
        let segments = MathSegments.split("$$E = mc^2$$")
        #expect(segments == [.displayMath("E = mc^2")])
    }

    @Test("underscores and backslashes survive verbatim")
    func contentVerbatim() {
        let segments = MathSegments.split("$$\\pi^*_{\\text{RFT}}(y\\mid x)$$")
        #expect(segments == [.displayMath("\\pi^*_{\\text{RFT}}(y\\mid x)")])
    }

    @Test("$$ inside a ``` fence is code, not math")
    func codeFenceImmune() {
        let text = """
        Run this:

        ```bash
        echo $$
        $$
        kill -9 $$
        ```

        Done.
        """
        #expect(MathSegments.split(text) == [.markdown(text)])
    }

    @Test("~~~ fence variant is also immune")
    func tildeFenceImmune() {
        let text = "~~~\n$$\nnot math\n$$\n~~~"
        #expect(MathSegments.split(text) == [.markdown(text)])
    }

    @Test("fence with info string containing no closer keeps $$ raw")
    func fenceInfoString() {
        let text = "```latex\n$$x$$\n```"
        #expect(MathSegments.split(text) == [.markdown(text)])
    }

    @Test("unclosed $$ (mid-stream) stays raw markdown until the closer arrives")
    func unclosedStaysRaw() {
        let streaming = "So far:\n\n$$\n\\frac{a}{b}"
        #expect(MathSegments.split(streaming) == [.markdown(streaming)])

        let settled = streaming + "\n$$"
        #expect(MathSegments.split(settled) == [
            .markdown("So far:\n"),
            .displayMath("\\frac{a}{b}"),
        ])
    }

    @Test("multiple blocks; blank-only gaps produce no empty segments")
    func multipleBlocks() {
        let text = "$$a$$\n\n$$\nb\n$$"
        #expect(MathSegments.split(text) == [.displayMath("a"), .displayMath("b")])
    }

    @Test("several $$…$$ spans on one line go to the inline pass, not display")
    func fusedSpansGoInline() {
        let text = "$$a$$ and $$b$$"
        #expect(MathSegments.split(text) == [.inlineParagraph(text)])
    }

    @Test("empty $$$$ and bare $$ $$ are not math")
    func emptyNotMath() {
        #expect(MathSegments.split("$$$$") == [.markdown("$$$$")])
        #expect(MathSegments.split("$$ $$") == [.markdown("$$ $$")])
    }

    @Test("indented $$ fence (≤3 spaces) still opens math")
    func indentedFence() {
        let text = "  $$\n  x^2\n  $$"
        #expect(MathSegments.split(text) == [.displayMath("x^2")])
    }
}
