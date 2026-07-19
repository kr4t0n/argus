import SwiftUI
import ArgusKit

/// Session-header token badge + context-window donut, mirroring the
/// web's UsageBadge: ↑ prompt / ↓ output totals, ring colored by the
/// live context fraction (green <60%, amber 60–85%, red ≥85%), full
/// breakdown in a popover. Ring hides when the model isn't in the
/// window table.
struct UsageBadge: View {
    let usage: TokenUsage?
    let context: ContextSnapshot?
    /// Ring-popover "Compact session" action — the caller gates it
    /// (claude-code only, idle only) and wires the /compact dispatch;
    /// nil hides the button.
    var onCompact: (() -> Void)? = nil

    @State private var showBreakdown = false

    var body: some View {
        // iPhone header real estate is tight: the badge is JUST the
        // ring — tap it for the full breakdown. The ↑/↓ totals the web
        // shows inline render only as the fallback tap target when the
        // model isn't in the window table (no ring), so the breakdown
        // never becomes unreachable.
        if usage != nil || context?.fraction != nil {
            Button {
                showBreakdown = true
            } label: {
                if let fraction = context?.fraction {
                    ContextRing(fraction: fraction)
                        .padding(4)
                        .contentShape(Rectangle())
                } else if let usage {
                    Text("↑\(TokenFormat.compact(promptTokens(usage))) ↓\(TokenFormat.compact(usage.outputTokens))")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showBreakdown, arrowEdge: .top) {
                BreakdownView(usage: usage, context: context, onCompact: onCompact.map { action in
                    { showBreakdown = false; action() }
                })
                .presentationCompactAdaptation(.popover)
            }
        }
    }

    private func promptTokens(_ usage: TokenUsage) -> Double {
        usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    }
}

struct ContextRing: View {
    let fraction: Double
    /// Sized to the toolbar's circular SF Symbols (ellipsis.circle ≈
    /// 20pt at body scale) so the ring reads as a peer control.
    var size: CGFloat = 20

    private var color: Color {
        if fraction >= 0.85 { return .red }
        if fraction >= 0.60 { return .orange }
        return .green
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(.quaternary, lineWidth: 3)
            Circle()
                .trim(from: 0, to: max(0.02, min(1, fraction)))
                .stroke(color, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: size, height: size)
    }
}

/// Exact port of the web UsageBreakdown tooltip: context block (family
/// + live percentage, a thin NEUTRAL bar — the ring is the threshold-
/// colored element, the bar deliberately isn't — and full comma-grouped
/// `used / window` digits) above a divider; the cumulative session rows
/// below it, no section headers, cache/cost/time rows only when > 0.
private struct BreakdownView: View {
    let usage: TokenUsage?
    let context: ContextSnapshot?
    var onCompact: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let context, let info = context.windowInfo {
                HStack(alignment: .firstTextBaseline) {
                    Text(info.family).foregroundStyle(.secondary)
                    Spacer(minLength: 12)
                    if let fraction = context.fraction {
                        Text(String(format: "%.1f%%", fraction * 100))
                            .monospacedDigit()
                    }
                }
                contextBar(fraction: min(1, context.fraction ?? 0))
                HStack(alignment: .firstTextBaseline) {
                    Text(TokenFormat.grouped(Double(context.usedTokens)))
                    Spacer(minLength: 12)
                    Text("/ \(TokenFormat.grouped(Double(info.window)))")
                }
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                if usage != nil {
                    Divider().padding(.vertical, 2)
                }
            }
            if let usage {
                labeled("Input", TokenFormat.grouped(usage.inputTokens))
                labeled("Output", TokenFormat.grouped(usage.outputTokens))
                if usage.cacheReadTokens > 0 {
                    labeled("Cache read", TokenFormat.grouped(usage.cacheReadTokens))
                }
                if usage.cacheWriteTokens > 0 {
                    labeled("Cache write", TokenFormat.grouped(usage.cacheWriteTokens))
                }
                if let cost = usage.costUsd, cost > 0 {
                    labeled("Cost", String(format: "$%.4f", cost))
                }
                if let apiMs = usage.durationApiMs, apiMs > 0 {
                    labeled("API time", TokenFormat.apiTime(ms: apiMs))
                }
            }
            if let onCompact {
                Button(action: onCompact) {
                    Text("Compact session")
                        .font(.caption)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .padding(.top, 2)
            }
        }
        .font(.caption)
        .padding(12)
        .frame(minWidth: 220)
    }

    private func contextBar(fraction: Double) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.surface2)
                Capsule()
                    .fill(Color.secondary.opacity(0.7))
                    .frame(width: geo.size.width * fraction)
            }
        }
        .frame(height: 4)
    }

    private func labeled(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value).monospacedDigit()
        }
    }
}

enum TokenFormat {
    /// Full comma-grouped digits (`301,119`) — the web tooltip's
    /// `toLocaleString` form.
    static func grouped(_ value: Double) -> String {
        Int(value).formatted(.number)
    }

    /// Port of the web `formatMs`: "980 ms", "45.3 s", "30m 28s".
    static func apiTime(ms: Double) -> String {
        if ms < 1000 { return String(format: "%.0f ms", ms) }
        let seconds = ms / 1000
        if seconds < 60 { return String(format: "%.1f s", seconds) }
        let minutes = Int(seconds / 60)
        let rest = Int((seconds - Double(minutes) * 60).rounded())
        return "\(minutes)m \(rest)s"
    }

    static func compact(_ value: Double) -> String {
        if value >= 1_000_000 {
            return String(format: "%.1fM", value / 1_000_000)
        }
        if value >= 1_000 {
            return String(format: "%.1fk", value / 1_000)
        }
        return String(Int(value))
    }

    static func duration(ms: Double) -> String {
        if ms >= 60_000 {
            return String(format: "%.1fm", ms / 60_000)
        }
        if ms >= 1_000 {
            return String(format: "%.1fs", ms / 1_000)
        }
        return String(format: "%.0fms", ms)
    }
}
