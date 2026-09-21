import Foundation
import Testing
@testable import ArgusKit

@Suite("SessionMatch — port of apps/web/src/lib/sessionMatch.ts")
struct SessionMatchTests {
    /// Fixed clock so recency is deterministic.
    private static let now = ISO8601.parse("2026-09-21T12:00:00.000Z")!
    private static let today = "2026-09-21T11:00:00.000Z"
    private static let lastMonth = "2026-08-01T11:00:00.000Z"

    private func candidate(
        _ title: String,
        id: String = UUID().uuidString,
        project: String? = nil,
        machine: String? = nil,
        cliType: String? = "claude-code",
        updatedAt: String = SessionMatchTests.today,
        archived: Bool = false
    ) -> SessionCandidate {
        SessionCandidate(
            session: TestSupport.session(
                id: id,
                title: title,
                cliType: cliType,
                updatedAt: updatedAt,
                archivedAt: archived ? "2026-09-20T00:00:00.000Z" : nil
            ),
            projectLabel: project,
            machineName: machine
        )
    }

    private func rank(_ query: String, _ candidates: [SessionCandidate], limit: Int = 12) -> [String] {
        SessionMatch.rank(query: query, candidates: candidates, limit: limit, now: Self.now)
            .map(\.session.title)
    }

    // MARK: fuzzyScore

    @Test("a contiguous substring always outranks a scattered subsequence")
    func substringBeatsSubsequence() throws {
        let substring = try #require(SessionMatch.fuzzyScore(query: "argus", text: "fix the argus sidebar"))
        let subsequence = try #require(SessionMatch.fuzzyScore(query: "ags", text: "argus"))
        #expect(substring > subsequence)
        #expect(subsequence <= SessionMatch.subsequenceCeiling)
        #expect(substring >= 60)
    }

    @Test("prefix > word boundary > mid-word for the same substring")
    func positionBonuses() throws {
        let prefix = try #require(SessionMatch.fuzzyScore(query: "side", text: "sidebar fix"))
        let boundary = try #require(SessionMatch.fuzzyScore(query: "side", text: "fix sidebar"))
        let mid = try #require(SessionMatch.fuzzyScore(query: "bar", text: "sidebar"))
        #expect(prefix > boundary)
        #expect(boundary > mid)
    }

    @Test("path separators and kebab/snake dashes count as word boundaries")
    func identifierBoundaries() throws {
        let slash = try #require(SessionMatch.fuzzyScore(query: "web", text: "apps/web"))
        let dash = try #require(SessionMatch.fuzzyScore(query: "code", text: "claude-code"))
        let plain = try #require(SessionMatch.fuzzyScore(query: "code", text: "encoder"))
        #expect(slash > 60 + 12)  // boundary bonus landed
        #expect(dash > plain)
    }

    @Test("case-insensitive; empty query scores 0; empty text is no match")
    func edges() {
        #expect(SessionMatch.fuzzyScore(query: "ARGUS", text: "argus") == SessionMatch.fuzzyScore(query: "argus", text: "ARGUS"))
        #expect(SessionMatch.fuzzyScore(query: "", text: "anything") == 0)
        #expect(SessionMatch.fuzzyScore(query: "x", text: "") == nil)
        #expect(SessionMatch.fuzzyScore(query: "xyz", text: "argus") == nil)
    }

    // MARK: rank

    @Test("empty query lists live sessions newest first, capped, never archived")
    func emptyQueryIsRecents() {
        let candidates = [
            candidate("old", updatedAt: "2026-09-01T00:00:00.000Z"),
            candidate("newest", updatedAt: "2026-09-21T10:00:00.000Z"),
            candidate("archived-newer", updatedAt: "2026-09-21T11:00:00.000Z", archived: true),
            candidate("middle", updatedAt: "2026-09-10T00:00:00.000Z"),
        ]
        #expect(rank("", candidates) == ["newest", "middle", "old"])
        #expect(rank("   ", candidates) == ["newest", "middle", "old"])
        #expect(rank("", candidates, limit: 2) == ["newest", "middle"])
        #expect(SessionMatch.rank(query: "", candidates: candidates, limit: 5, now: Self.now)
            .allSatisfy { $0.score == 0 })
    }

    @Test("archived sessions rank strictly below every live match, even a better one")
    func archivedSinkBelowLive() {
        let candidates = [
            // Exact prefix match, touched today — the better match by score.
            candidate("argus", updatedAt: Self.today, archived: true),
            // Weaker (mid-boundary) match, a month old.
            candidate("notes on argus", updatedAt: Self.lastMonth),
        ]
        #expect(rank("argus", candidates) == ["notes on argus", "argus"])
    }

    @Test("sessions matching no field are excluded")
    func noMatchExcluded() {
        let candidates = [candidate("deploy pipeline"), candidate("argus sidebar")]
        #expect(rank("zzz", candidates).isEmpty)
        #expect(rank("argus", candidates) == ["argus sidebar"])
    }

    @Test("recency is additive: the same match quality ranks the newer session first")
    func recencyBreaksTies() {
        let candidates = [
            candidate("argus", updatedAt: Self.lastMonth),
            candidate("argus", id: "b", updatedAt: Self.today),
        ]
        let ranked = SessionMatch.rank(query: "argus", candidates: candidates, limit: 5, now: Self.now)
        #expect(ranked.map(\.id).first == "b")
        // ~35 today, decaying with a ~10-day half-life; unparseable = 0.
        #expect(abs(SessionMatch.recencyBonus(updatedAt: Self.today, now: Self.now) - 35) < 0.5)
        #expect(SessionMatch.recencyBonus(updatedAt: "not a date", now: Self.now) == 0)
        #expect(SessionMatch.recencyBonus(updatedAt: Self.lastMonth, now: Self.now) < 5)
    }

    @Test("title outranks a machine-name match of equal quality (field weights)")
    func fieldWeights() {
        let candidates = [
            candidate("zzz", machine: "argus"),
            candidate("argus", id: "title-hit"),
        ]
        let ranked = SessionMatch.rank(query: "argus", candidates: candidates, limit: 5, now: Self.now)
        #expect(ranked.map(\.id).first == "title-hit")
    }

    @Test("project, machine and cliType are all matchable")
    func matchesEveryField() {
        let candidates = [
            candidate("untitled one", id: "by-project", project: "argus"),
            candidate("untitled two", id: "by-machine", machine: "gpu-box"),
            candidate("untitled three", id: "by-cli", cliType: "codex"),
        ]
        #expect(rank("argus", candidates) == ["untitled one"])
        #expect(rank("gpu", candidates) == ["untitled two"])
        #expect(rank("codex", candidates) == ["untitled three"])
    }

    @Test("limit caps the scored list too")
    func limitApplies() {
        let candidates = (0..<20).map { candidate("argus \($0)", id: "s\($0)") }
        #expect(rank("argus", candidates, limit: 3).count == 3)
        #expect(rank("argus", candidates, limit: 0).isEmpty)
    }
}
