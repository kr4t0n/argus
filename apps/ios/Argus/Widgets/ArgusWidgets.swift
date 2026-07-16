import ActivityKit
import SwiftUI
import WidgetKit

// The Live Activity UI — lock-screen card + Dynamic Island for a
// running turn. This extension deliberately depends on NOTHING but the
// shared attributes: no ArgusKit, no app asset catalog (SF Symbols
// only), so it builds fast and can't drag app state into the widget
// process.

@main
struct ArgusWidgetBundle: WidgetBundle {
    var body: some Widget {
        TurnLiveActivity()
    }
}

private let emerald = Color(red: 0x10 / 255.0, green: 0xB9 / 255.0, blue: 0x81 / 255.0)

struct TurnLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TurnActivityAttributes.self) { context in
            LockScreenCard(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    StateIcon(state: context.state)
                        .font(.title2)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.sessionTitle)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        StatusLine(context: context)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    TrailingTime(context: context)
                        .padding(.trailing, 4)
                }
            } compactLeading: {
                StateIcon(state: context.state)
            } compactTrailing: {
                if context.state.isRunning {
                    Text(context.attributes.startedAt, style: .timer)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(emerald)
                        .frame(maxWidth: 44)
                        .multilineTextAlignment(.trailing)
                } else {
                    StateIcon(state: context.state)
                }
            } minimal: {
                StateIcon(state: context.state)
            }
            .keylineTint(emerald)
        }
    }
}

/// Lock-screen presentation: icon · title + status line · elapsed.
private struct LockScreenCard: View {
    let context: ActivityViewContext<TurnActivityAttributes>

    var body: some View {
        HStack(spacing: 12) {
            StateIcon(state: context.state)
                .font(.title2)
                .frame(width: 34, height: 34)
                .background(.quaternary.opacity(0.5), in: Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(context.attributes.sessionTitle)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                StatusLine(context: context)
            }

            Spacer(minLength: 8)

            TrailingTime(context: context)
        }
        .padding(14)
        .activityBackgroundTint(nil)
    }
}

/// Spinner-stand-in while running (widgets can't animate ProgressView
/// reliably), ✓/✗ once settled.
private struct StateIcon: View {
    let state: TurnActivityAttributes.ContentState

    var body: some View {
        if state.isRunning {
            Image(systemName: "sparkle")
                .foregroundStyle(emerald)
        } else if state.isFailed {
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.red)
        } else {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(emerald)
        }
    }
}

/// "N tools · last tool" while running; "Completed/Failed · N tools"
/// once settled. lastTool is the tool's own label line — same text as
/// the transcript's pill.
private struct StatusLine: View {
    let context: ActivityViewContext<TurnActivityAttributes>

    var body: some View {
        let state = context.state
        Group {
            if state.isRunning {
                if state.toolCount > 0 {
                    Text("\(state.toolCount) tool\(state.toolCount == 1 ? "" : "s") · \(state.lastTool)")
                } else {
                    Text("Working…")
                }
            } else {
                Text("\(state.isFailed ? "Failed" : "Completed") · \(state.toolCount) tool\(state.toolCount == 1 ? "" : "s")")
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
}

/// Count-up timer while running (ticks on-device, no pushes); final
/// state label when done.
private struct TrailingTime: View {
    let context: ActivityViewContext<TurnActivityAttributes>

    var body: some View {
        if context.state.isRunning {
            Text(context.attributes.startedAt, style: .timer)
                .font(.callout.monospacedDigit())
                .foregroundStyle(emerald)
                .frame(maxWidth: 60)
                .multilineTextAlignment(.trailing)
        } else {
            Image(systemName: context.state.isFailed ? "xmark" : "checkmark")
                .font(.caption.weight(.bold))
                .foregroundStyle(context.state.isFailed ? .red : emerald)
        }
    }
}
