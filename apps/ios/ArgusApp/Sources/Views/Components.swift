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

    // Brand colors from apps/web tailwind tokens (`agent.*`).
    static let agentClaude = Color(hex: 0xFB923C)
    static let agentCodex = Color(hex: 0x10B981)
    static let agentCursor = Color(hex: 0x38BDF8)
    static let agentCustom = Color(hex: 0xA3A3A3)
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
