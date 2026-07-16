import Testing
@testable import ArgusKit

@Suite("UsageParser — port of packages/shared-types/src/usage.ts")
struct UsageMathTests {
    @Test("claude-code: snake_case usage + root-level cost/api-ms")
    func claudeCodeParse() throws {
        let meta: [String: JSONValue] = [
            "usage": .object([
                "input_tokens": .number(1200),
                "output_tokens": .number(340),
                "cache_read_input_tokens": .number(20000),
                "cache_creation_input_tokens": .number(1500),
            ]),
            "total_cost_usd": .number(0.42),
            "duration_api_ms": .number(9000),
        ]
        let usage = try #require(
            UsageParser.parseUsage(adapterType: KnownAgentType.claudeCode, meta: meta)
        )
        #expect(usage.inputTokens == 1200)
        #expect(usage.outputTokens == 340)
        #expect(usage.cacheReadTokens == 20000)
        #expect(usage.cacheWriteTokens == 1500)
        #expect(usage.costUsd == 0.42)
        #expect(usage.durationApiMs == 9000)
    }

    @Test("codex: input_tokens is TOTAL — normalize to disjoint buckets")
    func codexNormalization() throws {
        let meta: [String: JSONValue] = [
            "usage": .object([
                "input_tokens": .number(10_000),
                "cached_input_tokens": .number(9_000),
                "output_tokens": .number(500),
            ])
        ]
        let usage = try #require(
            UsageParser.parseUsage(adapterType: KnownAgentType.codex, meta: meta)
        )
        #expect(usage.inputTokens == 1_000)
        #expect(usage.cacheReadTokens == 9_000)
        #expect(usage.cacheWriteTokens == 0)
    }

    @Test("cursor-cli: camelCase fields")
    func cursorParse() throws {
        let meta: [String: JSONValue] = [
            "usage": .object([
                "inputTokens": .number(800),
                "outputTokens": .number(120),
                "cacheReadTokens": .number(3000),
                "cacheWriteTokens": .number(50),
            ])
        ]
        let usage = try #require(
            UsageParser.parseUsage(adapterType: KnownAgentType.cursorCLI, meta: meta)
        )
        #expect(usage.inputTokens == 800)
        #expect(usage.cacheWriteTokens == 50)
    }

    @Test("unknown adapter probes both conventions; numeric strings parse")
    func customAdapterFallback() throws {
        let meta: [String: JSONValue] = [
            "usage": .object([
                "inputTokens": .string("700"),
                "output_tokens": .number(50),
            ])
        ]
        let usage = try #require(UsageParser.parseUsage(adapterType: "my-agent", meta: meta))
        #expect(usage.inputTokens == 700)
        #expect(usage.outputTokens == 50)
    }

    @Test("no usage payload / all-zero usage → nil")
    func emptyReturnsNil() {
        #expect(UsageParser.parseUsage(adapterType: KnownAgentType.claudeCode, meta: nil) == nil)
        #expect(
            UsageParser.parseUsage(
                adapterType: KnownAgentType.claudeCode,
                meta: ["usage": .object(["input_tokens": .number(0)])]
            ) == nil
        )
    }

    @Test("parseContextUsage: iterations[-1] beats the cumulative aggregate")
    func contextUsesLastIteration() throws {
        // Mirrors the verified claude-code overcount: top-level usage is
        // the whole-turn aggregate; iterations[-1] is the live context.
        let meta: [String: JSONValue] = [
            "usage": .object([
                "input_tokens": .number(150_000),
                "output_tokens": .number(4_000),
                "cache_read_input_tokens": .number(7_000),
                "iterations": .array([
                    .object(["input_tokens": .number(120_000)]),
                    .object([
                        "input_tokens": .number(1_600),
                        "cache_read_input_tokens": .number(25_000),
                        "output_tokens": .number(900),
                    ]),
                ]),
            ])
        ]
        let context = try #require(
            UsageParser.parseContextUsage(adapterType: KnownAgentType.claudeCode, meta: meta)
        )
        #expect(context.inputTokens == 1_600)
        #expect(context.cacheReadTokens == 25_000)

        // Without iterations it falls back to the aggregate.
        var noIterations = meta
        noIterations["usage"] = .object([
            "input_tokens": .number(150_000),
            "output_tokens": .number(4_000),
        ])
        let fallback = try #require(
            UsageParser.parseContextUsage(
                adapterType: KnownAgentType.claudeCode, meta: noIterations
            )
        )
        #expect(fallback.inputTokens == 150_000)
    }

    @Test("parseModel: top-level beats nested envelopes")
    func modelProbeOrder() {
        #expect(UsageParser.parseModel(meta: nil) == nil)
        #expect(
            UsageParser.parseModel(meta: [
                "model": .string("claude-opus-4-8"),
                "message": .object(["model": .string("stale-inner")]),
            ]) == "claude-opus-4-8"
        )
        #expect(
            UsageParser.parseModel(meta: [
                "msg": .object(["session": .object(["model": .string("gpt-5-codex")])])
            ]) == "gpt-5-codex"
        )
    }

    @Test("TokenUsage.adding keeps optional fields unset when unset on both")
    func sumOptionalContract() {
        let a = TokenUsage(inputTokens: 1, outputTokens: 2)
        let b = TokenUsage(inputTokens: 3, outputTokens: 4)
        let sum = a.adding(b)
        #expect(sum.inputTokens == 4)
        #expect(sum.costUsd == nil)

        let c = TokenUsage(inputTokens: 0, outputTokens: 0, costUsd: 0.1)
        #expect(a.adding(c).costUsd == 0.1)
    }
}
