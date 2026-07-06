import SwiftUI
import ArgusKit

// Shared UI atoms. Native idioms (SF Symbols, system colors, Dynamic
// Type) carrying over Argus's semantic colors: the agent brand colors
// and the amber/emerald/red status-dot grammar from the web sidebar.

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }

    /// Theme-adaptive color from two hex literals (light / dark).
    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { trait in
            UIColor(Color(hex: trait.userInterfaceStyle == .dark ? dark : light))
        })
    }

    // Brand colors from apps/web tailwind tokens (`agent.*`).
    static let agentClaude = Color(hex: 0xFB923C)
    static let agentCodex = Color(hex: 0x10B981)
    static let agentCursor = Color(hex: 0x38BDF8)
    static let agentCustom = Color(hex: 0xA3A3A3)

    // Layered greys mapped to the web's surface-0/1/2 tokens. The system
    // grouped backgrounds already stack light↔dark the same way.
    static let surface0 = Color(.systemBackground)
    static let surface1 = Color(.secondarySystemBackground)
    static let surface2 = Color(.tertiarySystemBackground)

    /// Inline-code accent (`.markdown code`): red-700 light / blue-200 dark.
    static let codeInlineFg = Color(light: 0xB91C1C, dark: 0xBFDBFE)
    /// Markdown link color (sky-600 / sky-400).
    static let mdLink = Color(light: 0x0284C7, dark: 0x38BDF8)
    /// Amber (agent tool tint): amber-600 / amber-400.
    static let toolAmber = Color(light: 0xD97706, dark: 0xFBBF24)
}

/// Per-tool icon + tint, mirroring the web ToolPill's `iconFor` /
/// `iconColorFor`. Keyed off the lowercased tool name.
enum ToolStyle {
    static func symbol(for rawName: String?) -> String {
        switch (rawName ?? "").lowercased() {
        case "read", "cat", "open": return "doc.text"
        case "write", "create": return "doc.badge.plus"
        case "edit", "patch", "multiedit": return "pencil"
        case "delete", "remove", "rm": return "trash"
        case "rename", "move", "mv": return "arrow.left.arrow.right"
        case "grep": return "magnifyingglass"
        case "glob", "find", "ls": return "folder.badge.questionmark"
        case "bash", "shell", "exec", "run": return "terminal"
        case "fetch", "webfetch", "websearch": return "globe"
        case "task", "todo", "todowrite", "updatetodos",
             "taskcreate", "taskupdate", "tasklist", "taskget":
            return "list.bullet.indent"
        case "agent": return "cpu"
        case "codebase", "symbols": return "chevron.left.forwardslash.chevron.right"
        default: return "wrench.and.screwdriver"
        }
    }

    static func tint(for rawName: String?) -> Color {
        switch (rawName ?? "").lowercased() {
        case "read", "cat", "open", "codebase", "symbols": return .blue
        case "write", "create", "edit", "patch", "multiedit",
             "rename", "move", "mv": return .purple
        case "delete", "remove", "rm": return .pink
        case "grep", "search", "glob", "find", "ls": return .teal
        case "bash", "shell", "exec", "run": return .green
        case "fetch", "webfetch", "websearch": return .indigo
        case "task", "todo", "todowrite", "updatetodos",
             "taskcreate", "taskupdate", "tasklist", "taskget": return .orange
        case "agent": return .toolAmber
        default: return .secondary
        }
    }
}

enum AgentTypeStyle {
    static func color(for type: AgentType) -> Color {
        switch type {
        case KnownAgentType.claudeCode: return .agentClaude
        case KnownAgentType.codex: return .agentCodex
        case KnownAgentType.cursorCLI: return .agentCursor
        default: return .agentCustom
        }
    }

    static func symbol(for type: AgentType) -> String {
        switch type {
        case KnownAgentType.claudeCode: return "sparkle"
        case KnownAgentType.codex: return "chevron.left.forwardslash.chevron.right"
        case KnownAgentType.cursorCLI: return "cursorarrow.rays"
        default: return "cpu"
        }
    }
}

struct AgentTypeIcon: View {
    let type: AgentType
    var size: CGFloat = 14

    var body: some View {
        Image(systemName: AgentTypeStyle.symbol(for: type))
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(AgentTypeStyle.color(for: type))
    }
}

/// Sidebar status grammar (mirrors the web): amber = running, emerald =
/// done + unread, red = failed + unread, nothing otherwise.
struct SessionStatusDot: View {
    let session: SessionDTO

    private var color: Color? {
        if session.status == .active { return .orange }
        guard session.unread else { return nil }
        switch session.status {
        case .failed: return .red
        case .idle: return .green
        default: return nil
        }
    }

    var body: some View {
        if let color {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
        }
    }
}

enum RelativeTime {
    private static let formatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    static func label(iso: String) -> String {
        guard let date = ISO8601.parse(iso) else { return "" }
        return label(date: date)
    }

    static func label(msEpoch: Double) -> String {
        label(date: Date(timeIntervalSince1970: msEpoch / 1000))
    }

    private static func label(date: Date) -> String {
        // "in 0 sec" flickers on fresh events — clamp to "now".
        if abs(date.timeIntervalSinceNow) < 5 { return "now" }
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

/// Thin "reconnecting" strip shown while the socket is down but the app
/// believes it is logged in.
struct ConnectionBanner: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if !app.socketConnected {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Reconnecting…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity)
            .background(.yellow.opacity(0.15))
        }
    }
}
