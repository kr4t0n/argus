import Testing
@testable import ArgusKit

@Suite("ContextWindows — port of packages/shared-types/src/contextWindow.ts")
struct ContextWindowTests {
    @Test("claude API ids → 200k; [1m] variants → 1M")
    func claudeFamilies() {
        #expect(ContextWindows.lookup(model: "claude-opus-4-8")?.window == 200_000)
        #expect(ContextWindows.lookup(model: "claude-sonnet-4-6[1m]")?.window == 1_000_000)
    }

    @Test("cursor display names match by bare family word")
    func cursorDisplayNames() {
        #expect(ContextWindows.lookup(model: "Opus 4.7 1M Extra High Thinking")?.window == 1_000_000)
        #expect(ContextWindows.lookup(model: "Sonnet 4.6 Thinking")?.window == 200_000)
    }

    @Test("word boundaries: 'octopus' is not Opus")
    func wordBoundaries() {
        #expect(ContextWindows.lookup(model: "octopus-9000") == nil)
        #expect(ContextWindows.lookup(model: "sonnetics") == nil)
    }

    @Test("Fable is 1M by default — no [1m] marker in either id shape")
    func fableFamilies() {
        let api = ContextWindows.lookup(model: "claude-fable-5")
        #expect(api?.window == 1_000_000)
        #expect(api?.family == "Claude Fable")
        // cursor-cli display name: no "claude" substring at all.
        #expect(ContextWindows.lookup(model: "Fable 5 1M Max Thinking")?.window == 1_000_000)
    }

    @Test("word boundaries: 'affable' is not Fable")
    func fableFalsePositives() {
        #expect(ContextWindows.lookup(model: "affable-9000") == nil)
        #expect(ContextWindows.lookup(model: "unfable") == nil)
        #expect(ContextWindows.lookup(model: "fables-1") == nil)
    }

    @Test("OpenAI families")
    func openAIFamilies() {
        #expect(ContextWindows.lookup(model: "gpt-5-codex")?.window == 400_000)
        #expect(ContextWindows.lookup(model: "gpt-4.1-mini")?.window == 1_000_000)
        #expect(ContextWindows.lookup(model: "gpt-4o")?.window == 128_000)
        #expect(ContextWindows.lookup(model: "o3-pro")?.window == 200_000)
    }

    @Test("unknown / empty models hide the ring (nil)")
    func unknownIsNil() {
        #expect(ContextWindows.lookup(model: "totally-new-model") == nil)
        #expect(ContextWindows.lookup(model: nil) == nil)
        #expect(ContextWindows.lookup(model: "") == nil)
    }
}
