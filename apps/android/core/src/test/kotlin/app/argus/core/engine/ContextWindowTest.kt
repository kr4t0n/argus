package app.argus.core.engine

import app.argus.core.model.ModelCatalogEntry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

// Port of apps/ios/ArgusKit/Tests/ArgusKitTests/ContextWindowTests.swift.

/** ContextWindows — port of packages/shared-types/src/contextWindow.ts. */
class ContextWindowTest {
    @Test
    fun `claude API ids are 200k and 1m variants are 1M`() {
        assertEquals(200_000, ContextWindows.lookup("claude-opus-4-8")?.window)
        assertEquals(1_000_000, ContextWindows.lookup("claude-sonnet-4-6[1m]")?.window)
    }

    @Test
    fun `cursor display names match by bare family word`() {
        assertEquals(1_000_000, ContextWindows.lookup("Opus 4.7 1M Extra High Thinking")?.window)
        assertEquals(200_000, ContextWindows.lookup("Sonnet 4.6 Thinking")?.window)
    }

    @Test
    fun `word boundaries octopus is not Opus`() {
        assertNull(ContextWindows.lookup("octopus-9000"))
        assertNull(ContextWindows.lookup("sonnetics"))
    }

    @Test
    fun `Fable is 1M by default with no 1m marker in either id shape`() {
        val api = ContextWindows.lookup("claude-fable-5")
        assertEquals(1_000_000, api?.window)
        assertEquals("Claude Fable", api?.family)
        // cursor-cli display name: no "claude" substring at all.
        assertEquals(1_000_000, ContextWindows.lookup("Fable 5 1M Max Thinking")?.window)
    }

    @Test
    fun `Opus 5 is 1M by default for bare id point release and display name`() {
        val api = ContextWindows.lookup("claude-opus-5")
        assertEquals(1_000_000, api?.window)
        assertEquals("Claude Opus 5", api?.family)
        assertEquals(1_000_000, ContextWindows.lookup("claude-opus-5-20260601")?.window)
        assertEquals(1_000_000, ContextWindows.lookup("claude-opus-5[1m]")?.window)
        assertEquals(1_000_000, ContextWindows.lookup("Opus 5 Max Thinking")?.window)
    }

    @Test
    fun `Opus 5 entry does not claim the 200k Opus 4x ids`() {
        assertEquals("Claude", ContextWindows.lookup("claude-opus-4-8")?.family)
        assertEquals(200_000, ContextWindows.lookup("claude-opus-4-5")?.window)
        // Trailing boundary: a hypothetical `opus-50` must not match.
        assertEquals(200_000, ContextWindows.lookup("claude-opus-50")?.window)
    }

    @Test
    fun `word boundaries affable is not Fable`() {
        assertNull(ContextWindows.lookup("affable-9000"))
        assertNull(ContextWindows.lookup("unfable"))
        assertNull(ContextWindows.lookup("fables-1"))
    }

    @Test
    fun `OpenAI families`() {
        // 272k, not 400k: `codex debug models` reports context_window
        // 272000 for every listed gpt-5.x slug. The old 400k made the ring
        // read ~32% emptier than reality.
        assertEquals(272_000, ContextWindows.lookup("gpt-5-codex")?.window)
        assertEquals(272_000, ContextWindows.lookup("gpt-5.6-sol")?.window)
        assertEquals(1_000_000, ContextWindows.lookup("gpt-4.1-mini")?.window)
        assertEquals(128_000, ContextWindows.lookup("gpt-4o")?.window)
        assertEquals(200_000, ContextWindows.lookup("o3-pro")?.window)
    }

    @Test
    fun `unknown or empty models hide the ring`() {
        assertNull(ContextWindows.lookup("totally-new-model"))
        assertNull(ContextWindows.lookup(null))
        assertNull(ContextWindows.lookup(""))
    }

    // MARK: - resolve(model, catalog)

    private fun entry(id: String, window: Int?): ModelCatalogEntry =
        ModelCatalogEntry(
            id = id,
            displayName = id.uppercase(),
            description = null,
            contextWindow = window,
            isDefault = null,
            family = null,
            variantLabel = null,
            facets = null,
        )

    @Test
    fun `catalog wins over the static table`() {
        val catalog = listOf(entry(id = "gpt-5.6-sol", window = 400_000))
        val info = ContextWindows.resolve(model = "gpt-5.6-sol", catalog = catalog)
        assertEquals(400_000, info?.window)
        assertEquals("GPT-5.6-SOL", info?.family)
    }

    @Test
    fun `catalog id matching is exact then case-insensitive never substring`() {
        val catalog = listOf(entry(id = "GPT-5.6-Sol", window = 300_000))
        assertEquals(300_000, ContextWindows.resolve(model = "gpt-5.6-sol", catalog = catalog)?.window)
        // A sibling slug must NOT borrow this entry's window; it falls
        // through to the table instead.
        assertEquals(272_000, ContextWindows.resolve(model = "gpt-5.6-terra", catalog = catalog)?.window)
    }

    @Test
    fun `falls back to the table when the catalog is absent or windowless`() {
        assertEquals(272_000, ContextWindows.resolve(model = "gpt-5.6-sol", catalog = null)?.window)
        assertEquals(272_000, ContextWindows.resolve(model = "gpt-5.6-sol", catalog = emptyList())?.window)
        val windowless = listOf(entry(id = "gpt-5.6-sol", window = null))
        assertEquals(272_000, ContextWindows.resolve(model = "gpt-5.6-sol", catalog = windowless)?.window)
        val zero = listOf(entry(id = "gpt-5.6-sol", window = 0))
        assertEquals(272_000, ContextWindows.resolve(model = "gpt-5.6-sol", catalog = zero)?.window)
    }

    @Test
    fun `an unknown model with no catalog entry still hides the ring`() {
        assertNull(ContextWindows.resolve(model = "totally-new-model", catalog = emptyList()))
        assertNull(ContextWindows.resolve(model = null, catalog = null))
    }

    @Test
    fun `a turn-reported window outranks both catalog and table`() {
        val catalog = listOf(entry(id = "gpt-5.6-sol", window = 272_000))
        // Codex reports the usable ceiling (272000 * 0.95), not the nominal.
        val info = ContextWindows.resolve(
            model = "gpt-5.6-sol", catalog = catalog, reportedWindow = 258_400,
        )
        assertEquals(258_400, info?.window)
        // Label still comes from the name-keyed source.
        assertEquals("GPT-5.6-SOL", info?.family)
    }

    @Test
    fun `a reported window is trusted for a model nothing else recognises`() {
        val info = ContextWindows.resolve(
            model = "totally-new-model", catalog = emptyList(), reportedWindow = 300_000,
        )
        assertEquals(300_000, info?.window)
        assertEquals("totally-new-model", info?.family)
    }

    @Test
    fun `a missing or non-positive reported window falls through`() {
        assertEquals(
            272_000,
            ContextWindows.resolve(model = "gpt-5.6-sol", catalog = null, reportedWindow = null)?.window,
        )
        assertEquals(
            272_000,
            ContextWindows.resolve(model = "gpt-5.6-sol", catalog = null, reportedWindow = 0)?.window,
        )
    }
}
