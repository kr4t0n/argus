import Foundation

// Mirrors packages/shared-types/src/api.ts (terminals). The PTY is
// per-agent and opt-in at agent-create time (`supportsTerminal`); the
// server scopes terminals to the opening user and rejects opens for
// offline agents / agents without a PTY runner.

/// 'opening' | 'open' | 'closed' | 'error' — open string for tolerance.
public struct TerminalDTO: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var agentId: String
    public var userId: String
    public var status: String
    public var shell: String
    public var cwd: String?
    public var cols: Int
    public var rows: Int
    public var exitCode: Int?
    public var closeReason: String?
    public var openedAt: String
    public var closedAt: String?
}
