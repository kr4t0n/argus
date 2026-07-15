import Foundation
import Testing
@testable import ArgusKit

/// Decode REAL server responses captured by
/// `scripts/capture-ios-fixtures.sh`. This suite is the contract check:
/// when packages/shared-types changes shape, re-run the capture script
/// against a live server and these tests tell you whether the Swift
/// mirror still holds.
@Suite("Fixture decoding — captured live-server responses")
struct FixtureDecodingTests {
    @Test("login.json → LoginResponse")
    func login() throws {
        let response = try TestSupport.decodeFixture("login", as: LoginResponse.self)
        #expect(!response.user.id.isEmpty)
        #expect(response.user.role == "admin")
    }

    @Test("sessions.json → [SessionDTO]")
    func sessions() throws {
        let sessions = try TestSupport.decodeFixture("sessions", as: [SessionDTO].self)
        #expect(!sessions.isEmpty)
        for session in sessions {
            #expect(!session.id.isEmpty)
            #expect(session.status != .unknown)
        }
    }

    @Test("machines.json → [MachineDTO]")
    func machines() throws {
        let machines = try TestSupport.decodeFixture("machines", as: [MachineDTO].self)
        #expect(!machines.isEmpty)
        #expect(machines[0].availableAdapters.allSatisfy { !$0.type.isEmpty })
    }

    @Test("projects.json → [ProjectDTO]")
    func projects() throws {
        let projects = try TestSupport.decodeFixture("projects", as: [ProjectDTO].self)
        #expect(projects.allSatisfy { !$0.workingDir.isEmpty })
    }

    @Test("me-usage.json → UserUsageResponse")
    func usage() throws {
        let response = try TestSupport.decodeFixture("me-usage", as: UserUsageResponse.self)
        #expect(response.usage.lifetime.inputTokens >= 0)
    }

    @Test("me-quota.json → UserQuotaResponse")
    func quota() throws {
        let response = try TestSupport.decodeFixture("me-quota", as: UserQuotaResponse.self)
        #expect(response.quotas.allSatisfy { !$0.type.isEmpty })
    }

    @Test("me-extensions.json → UserExtensions")
    func extensions() throws {
        _ = try TestSupport.decodeFixture("me-extensions", as: UserExtensions.self)
    }

    @Test("model-catalog.json → ModelCatalogResponse")
    func modelCatalog() throws {
        let response = try TestSupport.decodeFixture("model-catalog", as: ModelCatalogResponse.self)
        #expect(!response.models.isEmpty)
        #expect(response.models.allSatisfy { !$0.id.isEmpty })
    }

    @Test("session-detail.json → SessionDetailResponse, and the engine digests it")
    func sessionDetail() throws {
        let detail = try TestSupport.decodeFixture("session-detail", as: SessionDetailResponse.self)
        #expect(!detail.commands.isEmpty)
        #expect(!detail.chunks.isEmpty)

        // REST chunks: ISO-string ts must have parsed to real millis, and
        // the absent sessionId/agentId/isFinal must not have broken decode.
        #expect(detail.chunks.allSatisfy { $0.ts > 0 })
        #expect(detail.chunks.allSatisfy { $0.sessionId == nil })
        #expect(detail.chunks.allSatisfy { $0.kind != .unknown })

        // End-to-end: the transcript engine builds turns from real data.
        var state = TranscriptState(sessionId: detail.session.id)
        state.applySnapshot(
            commands: detail.commands,
            chunks: detail.chunks,
            hasMore: detail.hasMore
        )
        let turns = state.turns(agentType: KnownAgentType.claudeCode)
        #expect(!turns.isEmpty)
        // A completed turn CAN legitimately be empty (Redis MAXLEN
        // trimming is a documented chunk-loss mode — the captured data
        // contains exactly such a turn: one bare content-less `final`).
        // Assert the properties the data does guarantee instead.
        let completed = turns.filter { $0.status == .completed }
        #expect(completed.contains { !$0.answer.isEmpty })
        let failed = turns.filter { $0.status == .failed }
        #expect(failed.allSatisfy { $0.errorText != nil })
    }
}
