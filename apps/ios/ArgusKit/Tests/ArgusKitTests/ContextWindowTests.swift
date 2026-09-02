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

    @Test("Opus 5 is 1M by default — bare id, point release, and display name")
    func opusFiveFamilies() {
        let api = ContextWindows.lookup(model: "claude-opus-5")
        #expect(api?.window == 1_000_000)
        #expect(api?.family == "Claude Opus 5")
        #expect(ContextWindows.lookup(model: "claude-opus-5-20260601")?.window == 1_000_000)
        #expect(ContextWindows.lookup(model: "claude-opus-5[1m]")?.window == 1_000_000)
        #expect(ContextWindows.lookup(model: "Opus 5 Max Thinking")?.window == 1_000_000)
    }

    @Test("Opus 5 entry does not claim the 200k Opus 4.x ids")
    func opusFiveDoesNotOverreach() {
        #expect(ContextWindows.lookup(model: "claude-opus-4-8")?.family == "Claude")
        #expect(ContextWindows.lookup(model: "claude-opus-4-5")?.window == 200_000)
        // Trailing boundary: a hypothetical `opus-50` must not match.
        #expect(ContextWindows.lookup(model: "claude-opus-50")?.window == 200_000)
    }

    @Test("word boundaries: 'affable' is not Fable")
    func fableFalsePositives() {
        #expect(ContextWindows.lookup(model: "affable-9000") == nil)
        #expect(ContextWindows.lookup(model: "unfable") == nil)
        #expect(ContextWindows.lookup(model: "fables-1") == nil)
    }

    @Test("OpenAI families")
    func openAIFamilies() {
        // 272k, not 400k: `codex debug models` reports context_window
        // 272000 for every listed gpt-5.x slug. The old 400k made the ring
        // read ~32% emptier than reality.
        #expect(ContextWindows.lookup(model: "gpt-5-codex")?.window == 272_000)
        #expect(ContextWindows.lookup(model: "gpt-5.6-sol")?.window == 272_000)
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

    // MARK: - resolve(model:catalog:)

    private func entry(id: String, window: Int?) -> ModelCatalogEntry {
        ModelCatalogEntry(
            id: id,
            displayName: id.uppercased(),
            description: nil,
            contextWindow: window,
            isDefault: nil,
            family: nil,
            variantLabel: nil,
            facets: nil
        )
    }

    @Test("catalog wins over the static table")
    func catalogWins() {
        let catalog = [entry(id: "gpt-5.6-sol", window: 400_000)]
        let info = ContextWindows.resolve(model: "gpt-5.6-sol", catalog: catalog)
        #expect(info?.window == 400_000)
        #expect(info?.family == "GPT-5.6-SOL")
    }

    @Test("catalog id matching is exact, then case-insensitive — never substring")
    func catalogMatching() {
        let catalog = [entry(id: "GPT-5.6-Sol", window: 300_000)]
        #expect(ContextWindows.resolve(model: "gpt-5.6-sol", catalog: catalog)?.window == 300_000)
        // A sibling slug must NOT borrow this entry's window; it falls
        // through to the table instead.
        #expect(ContextWindows.resolve(model: "gpt-5.6-terra", catalog: catalog)?.window == 272_000)
    }

    @Test("falls back to the table when the catalog is absent or windowless")
    func catalogFallback() {
        #expect(ContextWindows.resolve(model: "gpt-5.6-sol", catalog: nil)?.window == 272_000)
        #expect(ContextWindows.resolve(model: "gpt-5.6-sol", catalog: [])?.window == 272_000)
        let windowless = [entry(id: "gpt-5.6-sol", window: nil)]
        #expect(ContextWindows.resolve(model: "gpt-5.6-sol", catalog: windowless)?.window == 272_000)
        let zero = [entry(id: "gpt-5.6-sol", window: 0)]
        #expect(ContextWindows.resolve(model: "gpt-5.6-sol", catalog: zero)?.window == 272_000)
    }

    @Test("an unknown model with no catalog entry still hides the ring")
    func resolveUnknownIsNil() {
        #expect(ContextWindows.resolve(model: "totally-new-model", catalog: []) == nil)
        #expect(ContextWindows.resolve(model: nil, catalog: nil) == nil)
    }
}
