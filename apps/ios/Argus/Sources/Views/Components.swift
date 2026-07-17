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

    // Layered greys mirroring the web's surface-0/1/2 tokens EXACTLY
    // (index.css: light 97.3/92/87%, dark 4/9/15% lightness). These were
    // previously the system grouped backgrounds, which LOOK like the
    // same stack but aren't: iOS's tertiarySystemBackground is WHITE in
    // light mode (the system alternates white→gray→white for nesting),
    // so every surface2 consumer — prompt bubble, inline-code chip, bar
    // tracks — painted invisible white-on-white on the light theme.
    static let surface0 = Color(light: 0xF8F8F8, dark: 0x0A0A0A)
    static let surface1 = Color(light: 0xEBEBEB, dark: 0x171717)
    static let surface2 = Color(light: 0xDEDEDE, dark: 0x262626)

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

    /// The web's `iconColorFor`: exact tailwind tool colors (light -600 /
    /// dark -400) at 70% opacity — dimmer than full-saturation system
    /// colors. Default (unknown tool) is the muted foreground.
    static func tint(for rawName: String?) -> Color {
        let base: Color
        switch (rawName ?? "").lowercased() {
        case "read", "cat", "open", "codebase", "symbols":
            base = Color(light: 0x2563EB, dark: 0x60A5FA)  // blue
        case "write", "create", "edit", "patch", "multiedit",
             "rename", "move", "mv":
            base = Color(light: 0x7C3AED, dark: 0xA78BFA)  // violet
        case "delete", "remove", "rm":
            base = Color(light: 0xE11D48, dark: 0xFB7185)  // rose
        case "grep", "search", "glob", "find", "ls":
            base = Color(light: 0x0D9488, dark: 0x2DD4BF)  // teal
        case "bash", "shell", "exec", "run":
            base = Color(light: 0x059669, dark: 0x34D399)  // emerald
        case "fetch", "webfetch", "websearch":
            base = Color(light: 0x4F46E5, dark: 0x818CF8)  // indigo
        case "task", "todo", "todowrite", "updatetodos",
             "taskcreate", "taskupdate", "tasklist", "taskget":
            base = Color(light: 0xEA580C, dark: 0xFB923C)  // orange
        case "agent":
            base = Color(light: 0xD97706, dark: 0xFBBF24)  // amber
        default:
            return .secondary  // fg-muted, no /70
        }
        return base.opacity(0.7)
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

    /// Brand-glyph asset (Assets.xcassets), the actual @lobehub marks the
    /// web uses. nil for unknown adapters → SF-Symbol fallback.
    static func assetName(for type: AgentType) -> String? {
        switch type {
        case KnownAgentType.claudeCode: return "agent-claude-code"
        case KnownAgentType.codex: return "agent-codex"
        case KnownAgentType.cursorCLI: return "agent-cursor-cli"
        default: return nil
        }
    }

    /// Claude's mark carries its own brand orange (render as-is); Codex
    /// and Cursor are mono glyphs tinted with the primary label color —
    /// exactly how the web renders them (ClaudeCode.Color vs mono Codex/
    /// Cursor inheriting text-fg-primary). Codex additionally swaps to
    /// its brand-blue Color glyph in light mode (see AgentTypeIcon).
    static func assetIsTinted(for type: AgentType) -> Bool {
        type != KnownAgentType.claudeCode
    }
}

struct AgentTypeIcon: View {
    let type: AgentType
    var size: CGFloat = 14
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        // Codex mirrors the web's theme-resolved pick (AgentTypeIcon.tsx
        // codexEntry): light → the brand Color glyph (blue-gradient mark
        // on a white tile that blends into light surfaces), dark → the
        // mono glyph tinted primary, where the brand tile would pop as a
        // bright chip.
        if type == KnownAgentType.codex, colorScheme == .light {
            Image("agent-codex-brand")
                .renderingMode(.original)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
        } else if let asset = AgentTypeStyle.assetName(for: type) {
            if AgentTypeStyle.assetIsTinted(for: type) {
                Image(asset)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .frame(width: size, height: size)
                    .foregroundStyle(.primary)
            } else {
                Image(asset)
                    .renderingMode(.original)
                    .resizable()
                    .scaledToFit()
                    .frame(width: size, height: size)
            }
        } else {
            Image(systemName: "cpu")
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(.secondary)
        }
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
    // Foundation formatters are documented thread-safe on modern OSes;
    // nonisolated(unsafe) states that guarantee to Swift 6 (same
    // pattern as ArgusKit's ISO8601 caches).
    private nonisolated(unsafe) static let formatter: RelativeDateTimeFormatter = {
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

    /// Terse form for dense rows — "now", "5m", "18h", "16d" (web parity;
    /// always days past a day, no "ago").
    static func short(iso: String) -> String {
        guard let date = ISO8601.parse(iso) else { return "" }
        let seconds = max(0, -date.timeIntervalSinceNow)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
        return "\(Int(seconds / 86_400))d"
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

/// Bottom toast column for failed session-clone-from-turn events — the
/// web SessionCloneFailedToasts: amber warning card per session, newest
/// on top, auto-dismissed after 8s (the copy isn't actionable beyond
/// "next prompt starts fresh", so sticky would just be visual debt).
struct CloneFailureToasts: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: 8) {
            ForEach(app.cloneFailures.sorted { $0.startedAt > $1.startedAt }) { failure in
                CloneFailureCard(failure: failure) {
                    app.dismissCloneFailure(sessionId: failure.sessionId)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .frame(maxWidth: 420)
        .animation(.snappy, value: app.cloneFailures)
    }
}

private struct CloneFailureCard: View {
    let failure: AppModel.CloneFailure
    let onDismiss: () -> Void

    private static let autoDismiss: Duration = .seconds(8)

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(Color.toolAmber)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(failure.sessionTitle)
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text("clone failed")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Text("Couldn't fork CLI state. Next prompt will start a fresh conversation.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if !failure.reason.isEmpty {
                    Text(failure.reason)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .buttonStyle(.plain)
        }
        .padding(12)
        .background(Color.surface1, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.toolAmber.opacity(0.4)))
        .shadow(color: .black.opacity(0.25), radius: 10, y: 4)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .task {
            try? await Task.sleep(for: Self.autoDismiss)
            if !Task.isCancelled { onDismiss() }
        }
    }
}
