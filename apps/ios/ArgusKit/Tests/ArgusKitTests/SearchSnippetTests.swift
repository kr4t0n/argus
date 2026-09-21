import Testing
@testable import ArgusKit

@Suite("SearchSnippet — the web palette's renderSnippet, over [[hl]] sentinels")
struct SearchSnippetTests {
    typealias Run = SearchSnippet.Run

    @Test("one marked term splits into plain / highlighted / plain")
    func basicSplit() {
        let runs = SearchSnippet.runs("fix the [[hl]]sidebar[[/hl]] toggle")
        #expect(runs == [
            Run(text: "fix the ", highlighted: false),
            Run(text: "sidebar", highlighted: true),
            Run(text: " toggle", highlighted: false),
        ])
    }

    @Test("several marks, including one at the very start and end")
    func multipleMarks() {
        let runs = SearchSnippet.runs("[[hl]]a[[/hl]] and [[hl]]b[[/hl]]")
        #expect(runs == [
            Run(text: "a", highlighted: true),
            Run(text: " and ", highlighted: false),
            Run(text: "b", highlighted: true),
        ])
    }

    @Test("an unpaired start marker is literal text, not a swallowed tail")
    func unpairedStart() {
        #expect(SearchSnippet.runs("no close [[hl]]here") == [
            Run(text: "no close [[hl]]here", highlighted: false),
        ])
    }

    @Test("a stray stop marker before any start is literal text")
    func unpairedStop() {
        #expect(SearchSnippet.runs("stray [[/hl]] then [[hl]]ok[[/hl]]") == [
            Run(text: "stray [[/hl]] then ", highlighted: false),
            Run(text: "ok", highlighted: true),
        ])
    }

    @Test("whitespace and newlines collapse so a row stays two lines tall")
    func whitespaceCollapses() {
        #expect(SearchSnippet.runs("  first\n\n  line\t[[hl]]x[[/hl]]\n") == [
            Run(text: "first line ", highlighted: false),
            Run(text: "x", highlighted: true),
        ])
    }

    @Test("empty and marker-only input")
    func degenerate() {
        #expect(SearchSnippet.runs("").isEmpty)
        #expect(SearchSnippet.runs("[[hl]][[/hl]]").isEmpty)
    }

    @Test("sentinels match shared-types SEARCH_HL_START / SEARCH_HL_STOP")
    func sentinels() {
        #expect(SearchSnippet.highlightStart == "[[hl]]")
        #expect(SearchSnippet.highlightStop == "[[/hl]]")
    }
}
