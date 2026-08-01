import Testing
@testable import ArgusKit

@Suite("InlineMath — $…$ run extraction with web (micromark) parity")
struct InlineMathTests {
    @Test("no dollars → one text run")
    func noDollars() {
        #expect(InlineMath.runs("plain prose") == [.text("plain prose")])
    }

    @Test("simple span splits into text/math/text")
    func simpleSpan() {
        #expect(InlineMath.runs("keep $R(x,y)\\in\\{0,1\\}$, then SFT") == [
            .text("keep "),
            .math("R(x,y)\\in\\{0,1\\}"),
            .text(", then SFT"),
        ])
    }

    @Test("the accepted web false positive: $5 and then $10 mathifies")
    func dollarAmountsFalsePositive() {
        #expect(InlineMath.runs("costs $5 and then $10 more") == [
            .text("costs "),
            .math("5 and then "),
            .text("10 more"),
        ])
    }

    @Test("mid-paragraph $$…$$ is an inline span (double-length closer)")
    func doubleDollarInline() {
        #expect(InlineMath.runs("so $$E=mc^2$$ holds") == [
            .text("so "),
            .math("E=mc^2"),
            .text(" holds"),
        ])
    }

    @Test("mismatched dollar runs keep scanning like micromark")
    func mismatchedRuns() {
        #expect(InlineMath.runs("$a$$b$") == [.math("a$$b")])
    }

    @Test("backtick code spans shield their dollars")
    func codeSpanImmune() {
        #expect(InlineMath.runs("run `echo $$` for $x$") == [
            .text("run `echo $$` for "),
            .math("x"),
        ])
        #expect(InlineMath.runs("`$a` and `$b`") == [.text("`$a` and `$b`")])
    }

    @Test("escaped \\$ is a literal, never a delimiter")
    func escapedDollar() {
        #expect(InlineMath.runs("pay \\$5 for $x$") == [
            .text("pay \\$5 for "),
            .math("x"),
        ])
    }

    @Test("unclosed or empty spans stay text")
    func unclosedOrEmpty() {
        #expect(InlineMath.runs("lone $ dangling") == [.text("lone $ dangling")])
        #expect(InlineMath.runs("empty $$ here") == [.text("empty $$ here")])
        #expect(InlineMath.runs("blank $ $ span") == [.text("blank $ $ span")])
    }

    @Test("containsMath mirrors runs()")
    func containsMath() {
        #expect(InlineMath.containsMath("has $x$"))
        #expect(!InlineMath.containsMath("has `$x$` only"))
        #expect(!InlineMath.containsMath("no dollars"))
    }
}
