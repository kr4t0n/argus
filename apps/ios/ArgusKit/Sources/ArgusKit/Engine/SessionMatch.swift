import Foundation

/// Ranking for the ⌘P session switcher — a port of
/// `apps/web/src/lib/sessionMatch.ts`. Keep the two in lockstep: the
/// weights, bonuses and tie-breaks here ARE the web's, so the same query
/// ranks the same session first on both clients.
///
/// Pure: the caller assembles `SessionCandidate`s from the stores it
/// already holds (the whole session list is hydrated at boot), and
/// nothing here touches the network — at a few hundred sessions a
/// per-keystroke rank is far cheaper than a round-trip.
///
/// Known deviation from the TS original: string lengths and positions
/// are in grapheme clusters here and UTF-16 code units there. It only
/// moves the small length-specificity bonus, and only for non-BMP text.
public struct SessionCandidate: Equatable, Sendable {
    public let session: SessionDTO
    /// The project's display label — its picked name, else the working
    /// directory's basename. Nil for workdir-less sessions and for rows
    /// whose Project hasn't hydrated.
    public let projectLabel: String?
    public let machineName: String?
    /// The machine these labels name has been soft-deleted. Rendering
    /// only — scoring ignores it, so a removed machine's sessions stay
    /// matchable by project and host exactly like live ones. That
    /// searchability is the point: search is how deleted machines'
    /// history is reached at all.
    public let removed: Bool

    public init(
        session: SessionDTO,
        projectLabel: String?,
        machineName: String?,
        removed: Bool = false
    ) {
        self.session = session
        self.projectLabel = projectLabel
        self.machineName = machineName
        self.removed = removed
    }
}

public struct RankedSession: Equatable, Sendable, Identifiable {
    public let candidate: SessionCandidate
    public let score: Double

    public var id: String { candidate.session.id }
    public var session: SessionDTO { candidate.session }

    public init(candidate: SessionCandidate, score: Double) {
        self.candidate = candidate
        self.score = score
    }
}

public enum SessionMatch {
    /// Field weights. Titles are the thing people actually remember, but
    /// they are auto-derived from the first 60 chars of the opening
    /// prompt, so a lot of them are truncated near-duplicates — matching
    /// the project and machine too is what makes "argus" or "codex" a
    /// useful query.
    static let titleWeight = 1.0
    static let projectWeight = 0.9
    static let machineWeight = 0.75
    static let cliTypeWeight = 0.7

    /// Any subsequence hit scores below this, so a real substring match
    /// always outranks a scattered one.
    static let subsequenceCeiling = 55.0

    /// Characters that start a new "word" for match-quality purposes.
    /// Paths and kebab/snake identifiers are most of what we match
    /// against. (The TS original's `/[\s/\\\-_.:]/`.)
    static func isBoundary(_ character: Character) -> Bool {
        character.isWhitespace
            || character == "/" || character == "\\"
            || character == "-" || character == "_"
            || character == "." || character == ":"
    }

    /// How well `query` matches `text`, or nil for no match at all.
    ///
    /// Two tiers: a contiguous substring (strong, bonused for landing at
    /// a prefix or word boundary), else a subsequence walk that rewards
    /// consecutive characters and word-boundary hits.
    public static func fuzzyScore(query: String, text: String) -> Double? {
        if query.isEmpty { return 0 }
        if text.isEmpty { return nil }
        let q = Array(query.lowercased())
        let t = Array(text.lowercased())

        if let at = firstIndex(of: q, in: t) {
            var score = 60.0
            if at == 0 {
                score += 25
            } else if isBoundary(t[at - 1]) {
                score += 15
            }
            // Same match in a shorter field is the more specific one.
            score += max(0, 12 - Double(t.count) / 10)
            return score
        }

        var cursor = 0
        var streak = 0
        var score = 0.0
        for i in q.indices {
            guard let found = t[cursor...].firstIndex(of: q[i]) else { return nil }
            var point = 1.0
            if i > 0, found == cursor {
                streak += 1
                point += Double(streak * 2)
            } else {
                streak = 0
            }
            if found == 0 || isBoundary(t[found - 1]) { point += 3 }
            score += point
            cursor = found + 1
        }
        return min(subsequenceCeiling, score)
    }

    /// Recency bonus, in the same units as the match score. Half-life of
    /// about ten days: ~35 for something touched today, ~13 a fortnight
    /// later, ~2 at six weeks. Additive rather than a tiebreak because a
    /// loose match on a session from this morning genuinely is the better
    /// answer than a tight match on one from March.
    static func recencyBonus(updatedAt: String, now: Date) -> Double {
        guard let date = ISO8601.parse(updatedAt) else { return 0 }
        let ageDays = max(0, now.timeIntervalSince(date) / 86_400)
        return 35 * exp(-ageDays / 14)
    }

    static func bestFieldScore(query: String, candidate: SessionCandidate) -> Double? {
        let fields: [(String?, Double)] = [
            (candidate.session.title, titleWeight),
            (candidate.projectLabel, projectWeight),
            (candidate.machineName, machineWeight),
            (candidate.session.cliType, cliTypeWeight),
        ]
        var best: Double?
        for (text, weight) in fields {
            guard let text, !text.isEmpty else { continue }
            guard let score = fuzzyScore(query: query, text: text) else { continue }
            let weighted = score * weight
            if let current = best, weighted <= current { continue }
            best = weighted
        }
        return best
    }

    /// Rank sessions for the quick switcher.
    ///
    /// An empty query is the important case, not a degenerate one: it
    /// returns the most-recently-updated live sessions so switching is
    /// two keystrokes (⌘P, Enter). Archived sessions never appear there
    /// — with ~93% of sessions archived they would bury the handful
    /// actually in play — but they ARE reachable by typing, ranked
    /// strictly below every live match so they can't displace one.
    public static func rank(
        query: String,
        candidates: [SessionCandidate],
        limit: Int,
        now: Date = Date()
    ) -> [RankedSession] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let cap = max(0, limit)

        if q.isEmpty {
            return candidates
                .filter { $0.session.archivedAt == nil }
                .sorted { $0.session.updatedAt > $1.session.updatedAt }
                .prefix(cap)
                .map { RankedSession(candidate: $0, score: 0) }
        }

        var scored: [RankedSession] = []
        for candidate in candidates {
            guard let match = bestFieldScore(query: q, candidate: candidate) else { continue }
            let bonus = recencyBonus(updatedAt: candidate.session.updatedAt, now: now)
            scored.append(RankedSession(candidate: candidate, score: match + bonus))
        }
        scored.sort { a, b in
            let aArchived = a.session.archivedAt != nil
            let bArchived = b.session.archivedAt != nil
            if aArchived != bArchived { return !aArchived }
            if a.score != b.score { return a.score > b.score }
            return a.session.updatedAt > b.session.updatedAt
        }
        return Array(scored.prefix(cap))
    }

    /// Plain substring search over character arrays — the TS `indexOf`.
    private static func firstIndex(of needle: [Character], in haystack: [Character]) -> Int? {
        guard !needle.isEmpty, needle.count <= haystack.count else { return nil }
        let last = haystack.count - needle.count
        var start = 0
        while start <= last {
            if haystack[start] == needle[0] {
                var offset = 1
                while offset < needle.count, haystack[start + offset] == needle[offset] {
                    offset += 1
                }
                if offset == needle.count { return start }
            }
            start += 1
        }
        return nil
    }
}
