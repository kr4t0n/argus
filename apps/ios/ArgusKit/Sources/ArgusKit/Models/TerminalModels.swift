import Foundation

// Mirrors packages/shared-types/src/api.ts (terminals). The PTY is
// project-scoped and opt-in via the project's `supportsTerminal`; the
// server scopes terminals to the opening user and rejects opens on
// offline machines or projects without a PTY runner.

/// 'opening' | 'open' | 'closed' | 'error' — open string for tolerance.
public struct TerminalDTO: Codable, Equatable, Sendable, Identifiable {
    public var id: String
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
