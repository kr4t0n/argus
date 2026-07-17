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

    @State private var showBreakdown = false

    var body: some View {
        if usage != nil || context?.fraction != nil {
            Button {
                showBreakdown = true
            } label: {
                HStack(spacing: 5) {
                    if let usage {
                        Text("↑\(TokenFormat.compact(promptTokens(usage))) ↓\(TokenFormat.compact(usage.outputTokens))")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    if let fraction = context?.fraction {
                        ContextRing(fraction: fraction)
                    }
                }
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showBreakdown, arrowEdge: .top) {
                BreakdownView(usage: usage, context: context)
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
    var size: CGFloat = 15

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

private struct BreakdownView: View {
    let usage: TokenUsage?
    let context: ContextSnapshot?

    var body: some View {
        // Context block leads, details follow — the web popover's order
        // (model + ring up top, session KVs below).
        VStack(alignment: .leading, spacing: 8) {
            if let context, let info = context.windowInfo {
                Text("Context — \(info.family)")
                    .font(.caption.weight(.semibold))
                labeled(
                    "Live context",
                    "\(TokenFormat.compact(Double(context.usedTokens))) / \(TokenFormat.compact(Double(info.window)))"
                )
                if let fraction = context.fraction {
                    // Clamp: an overrun context (or a stale window table)
                    // must read as a full bar, not a runtime warning.
                    ProgressView(value: min(1, fraction))
                        .tint(fraction >= 0.85 ? .red : fraction >= 0.60 ? .orange : .green)
                }
                if usage != nil { Divider() }
            }
            if let usage {
                Text("Session usage")
                    .font(.caption.weight(.semibold))
                row("Input", usage.inputTokens)
                row("Output", usage.outputTokens)
                row("Cache read", usage.cacheReadTokens)
                row("Cache write", usage.cacheWriteTokens)
                if let cost = usage.costUsd {
                    labeled("Cost", String(format: "$%.2f", cost))
                }
                if let apiMs = usage.durationApiMs {
                    labeled("API time", TokenFormat.duration(ms: apiMs))
                }
            }
        }
        .font(.caption)
        .padding(12)
        .frame(minWidth: 220)
    }

    private func row(_ label: String, _ value: Double) -> some View {
        labeled(label, TokenFormat.compact(value))
    }

    private func labeled(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).monospacedDigit()
        }
    }
}

enum TokenFormat {
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
