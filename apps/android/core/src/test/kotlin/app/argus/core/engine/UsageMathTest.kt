package app.argus.core.engine

import app.argus.core.metaOf
import app.argus.core.model.KnownAgentType
import app.argus.core.model.TokenUsage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

// Port of apps/ios/ArgusKit/Tests/ArgusKitTests/UsageMathTests.swift.

/** UsageParser — port of packages/shared-types/src/usage.ts. */
class UsageMathTest {
    @Test
    fun `claude-code snake_case usage plus root-level cost and api ms`() {
        val meta = metaOf(
            """
            {
              "usage": {
                "input_tokens": 1200,
                "output_tokens": 340,
                "cache_read_input_tokens": 20000,
                "cache_creation_input_tokens": 1500
              },
              "total_cost_usd": 0.42,
              "duration_api_ms": 9000
            }
            """,
        )
        val usage = assertNotNull(UsageParser.parseUsage(KnownAgentType.CLAUDE_CODE, meta))
        assertEquals(1200.0, usage.inputTokens)
        assertEquals(340.0, usage.outputTokens)
        assertEquals(20000.0, usage.cacheReadTokens)
        assertEquals(1500.0, usage.cacheWriteTokens)
        assertEquals(0.42, usage.costUsd)
        assertEquals(9000.0, usage.durationApiMs)
    }

    @Test
    fun `codex input_tokens is total and normalizes to disjoint buckets`() {
        val meta = metaOf(
            """{"usage": {"input_tokens": 10000, "cached_input_tokens": 9000, "output_tokens": 500}}""",
        )
        val usage = assertNotNull(UsageParser.parseUsage(KnownAgentType.CODEX, meta))
        assertEquals(1000.0, usage.inputTokens)
        assertEquals(9000.0, usage.cacheReadTokens)
        assertEquals(0.0, usage.cacheWriteTokens)
    }

    @Test
    fun `cursor-cli camelCase fields`() {
        val meta = metaOf(
            """{"usage": {"inputTokens": 800, "outputTokens": 120, "cacheReadTokens": 3000, "cacheWriteTokens": 50}}""",
        )
        val usage = assertNotNull(UsageParser.parseUsage(KnownAgentType.CURSOR_CLI, meta))
        assertEquals(800.0, usage.inputTokens)
        assertEquals(50.0, usage.cacheWriteTokens)
    }

    @Test
    fun `unknown adapter probes both conventions and numeric strings parse`() {
        val meta = metaOf("""{"usage": {"inputTokens": "700", "output_tokens": 50}}""")
        val usage = assertNotNull(UsageParser.parseUsage("my-agent", meta))
        assertEquals(700.0, usage.inputTokens)
        assertEquals(50.0, usage.outputTokens)
    }

    @Test
    fun `no usage payload or all-zero usage returns null`() {
        assertNull(UsageParser.parseUsage(KnownAgentType.CLAUDE_CODE, null))
        assertNull(
            UsageParser.parseUsage(
                KnownAgentType.CLAUDE_CODE,
                metaOf("""{"usage": {"input_tokens": 0}}"""),
            ),
        )
    }

    @Test
    fun `parseContextUsage prefers the last iteration over the cumulative aggregate`() {
        // Mirrors the verified claude-code overcount: top-level usage is
        // the whole-turn aggregate; iterations[-1] is the live context.
        val meta = metaOf(
            """
            {
              "usage": {
                "input_tokens": 150000,
                "output_tokens": 4000,
                "cache_read_input_tokens": 7000,
                "iterations": [
                  {"input_tokens": 120000},
                  {"input_tokens": 1600, "cache_read_input_tokens": 25000, "output_tokens": 900}
                ]
              }
            }
            """,
        )
        val context = assertNotNull(UsageParser.parseContextUsage(KnownAgentType.CLAUDE_CODE, meta))
        assertEquals(1600.0, context.inputTokens)
        assertEquals(25000.0, context.cacheReadTokens)

        // Without iterations it falls back to the aggregate.
        val noIterations = metaOf("""{"usage": {"input_tokens": 150000, "output_tokens": 4000}}""")
        val fallback = assertNotNull(
            UsageParser.parseContextUsage(KnownAgentType.CLAUDE_CODE, noIterations),
        )
        assertEquals(150000.0, fallback.inputTokens)
    }

    @Test
    fun `parseContextUsage prefers codex lastUsage over the turn aggregate`() {
        val meta = metaOf(
            """
            {
              "usage": {"input_tokens": 100000, "cached_input_tokens": 60000},
              "lastUsage": {"input_tokens": 30000, "cached_input_tokens": 20000}
            }
            """,
        )
        val context = assertNotNull(UsageParser.parseContextUsage(KnownAgentType.CODEX, meta))
        assertEquals(10000.0, context.inputTokens)
        assertEquals(20000.0, context.cacheReadTokens)
    }

    @Test
    fun `parseModel top-level beats nested envelopes`() {
        assertNull(UsageParser.parseModel(null))
        assertEquals(
            "claude-opus-4-8",
            UsageParser.parseModel(
                metaOf("""{"model": "claude-opus-4-8", "message": {"model": "stale-inner"}}"""),
            ),
        )
        assertEquals(
            "gpt-5-codex",
            UsageParser.parseModel(metaOf("""{"msg": {"session": {"model": "gpt-5-codex"}}}""")),
        )
    }

    @Test
    fun `TokenUsage plus keeps optional fields unset when unset on both`() {
        val a = TokenUsage(inputTokens = 1.0, outputTokens = 2.0)
        val b = TokenUsage(inputTokens = 3.0, outputTokens = 4.0)
        val sum = a + b
        assertEquals(4.0, sum.inputTokens)
        assertNull(sum.costUsd)

        val c = TokenUsage(inputTokens = 0.0, outputTokens = 0.0, costUsd = 0.1)
        assertEquals(0.1, (a + c).costUsd)
    }
}
