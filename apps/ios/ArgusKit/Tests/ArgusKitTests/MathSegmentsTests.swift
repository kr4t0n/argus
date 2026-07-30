import Testing
@testable import ArgusKit

@Suite("MathSegments — $$ display-math extraction for the transcript")
struct MathSegmentsTests {
    @Test("no math → single markdown segment, text untouched")
    func noMathPassthrough() {
        let text = "Just prose with $5 and inline $x+y$ math."
        #expect(MathSegments.split(text) == [.markdown(text)])
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

    @Test("several $$…$$ spans fused on one line stay raw")
    func fusedSpansStayRaw() {
        let text = "$$a$$ and $$b$$"
        #expect(MathSegments.split(text) == [.markdown(text)])
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
