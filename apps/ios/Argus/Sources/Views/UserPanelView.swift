import SwiftUI
import Charts
import ArgusKit

/// The account screen — the iOS counterpart of the web's /user page:
/// activity heatmap, token-usage ledger with rolling windows, per-CLI
/// plan quota, extension toggles, and log out.
struct UserPanelView: View {
    @Environment(AppModel.self) private var app

    private enum Window: String, CaseIterable {
        case week = "7 days"
        case month = "30 days"
        case lifetime = "All time"
    }

    @State private var usage: WindowedUsage?
    @State private var window: Window = .month
    @State private var quotas: [UserQuotaRow] = []
    @State private var activity: [ActivityDay] = []
    @State private var loadError: String?

    var body: some View {
        List {
            accountSection
            activitySection
            usageSection
            quotaSection
            notificationsSection
            extensionsSection
            Section {
                Button("Log out", role: .destructive) { app.logOut() }
            }
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    // MARK: Sections

    private var accountSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: "person.circle.fill")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(app.user?.email ?? "—").font(.headline)
                    Text(app.user?.role ?? "").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let loadError {
                Text(loadError).font(.caption).foregroundStyle(.red)
            }
        }
    }

    private enum ActivityMode: String, CaseIterable {
        case grid = "Grid"
        case curve = "Curve"
    }

    @State private var activityMode: ActivityMode = .grid

    private var activitySection: some View {
        Section("Activity") {
            if activity.isEmpty {
                Text("No activity yet.").font(.callout).foregroundStyle(.secondary)
            } else {
                // Web parity: Grid/Curve segmented toggle over the same
                // /me/activity payload — pure client-side view swap.
                Picker("View", selection: $activityMode) {
                    ForEach(ActivityMode.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)

                switch activityMode {
                case .grid:
                    ActivityHeatmap(days: activity)
                        .listRowInsets(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12))
                case .curve:
                    ActivityCurve(days: activity)
                        .listRowInsets(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12))
                }
            }
        }
    }

    private var usageSection: some View {
        Section("Usage") {
            if let usage {
                Picker("Window", selection: $window) {
                    ForEach(Window.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)

                let current = selected(usage)
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                    stat("Input", TokenFormat.compact(current.inputTokens))
                    stat("Output", TokenFormat.compact(current.outputTokens))
                    stat("Cache read", TokenFormat.compact(current.cacheReadTokens))
                    stat("Cache write", TokenFormat.compact(current.cacheWriteTokens))
                    if let cost = current.costUsd {
                        stat("Cost", String(format: "$%.2f", cost))
                    }
                    if let apiMs = current.durationApiMs {
                        stat("API time", TokenFormat.duration(ms: apiMs))
                    }
                }
                .padding(.vertical, 4)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
    }

    private var quotaSection: some View {
        Section("Plan quota") {
            if quotas.isEmpty {
                Text("No quota reports from the fleet yet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(quotas.enumerated()), id: \.offset) { _, row in
                    QuotaRowView(row: row)
                }
            }
        }
    }

    @State private var pushDenied = false

    private var notificationsSection: some View {
        Section {
            Toggle("Task completion alerts", isOn: pushBinding)
        } header: {
            Text("Notifications")
        } footer: {
            if pushDenied {
                Text("Notifications are denied for Argus in system Settings — enable them there, then flip this back on.")
            } else {
                Text("A push arrives when a turn finishes in a session you're not looking at. Requires the server's APNS_* env to be configured.")
            }
        }
    }

    private var pushBinding: Binding<Bool> {
        Binding(
            get: { app.pushEnabled },
            set: { enabled in
                Task {
                    let granted = await app.setPushEnabled(enabled)
                    pushDenied = enabled && !granted
                }
            }
        )
    }

    private var extensionsSection: some View {
        Section {
            Toggle("Notes", isOn: extensionBinding(\.notes))
            Toggle("Progress", isOn: extensionBinding(\.progress))
            Toggle("Diff", isOn: extensionBinding(\.diff))
        } header: {
            Text("Extensions")
        } footer: {
            Text("Account-level opt-ins, synced with the web dashboard. Each enabled extension adds its tab to the session inspector.")
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.title3.monospacedDigit().weight(.semibold))
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func selected(_ usage: WindowedUsage) -> TokenUsage {
        switch window {
        case .week: return usage.last7Days
        case .month: return usage.last30Days
        case .lifetime: return usage.lifetime
        }
    }

    /// Extensions live app-wide on AppModel (the inspector gates its
    /// tabs on them); each toggle PUTs the full flag set like the web.
    private func extensionBinding(_ keyPath: WritableKeyPath<UserExtensions, Bool>) -> Binding<Bool> {
        Binding(
            get: { app.extensions[keyPath: keyPath] },
            set: { newValue in
                var updated = app.extensions
                updated[keyPath: keyPath] = newValue
                Task { await app.setExtensions(updated) }
            }
        )
    }

    private func load() async {
        guard let client = app.client else { return }
        do {
            async let usageResponse = client.getMyUsage()
            async let quotaResponse = client.getMyQuota()
            async let activityResponse = client.getMyActivity()
            usage = try await usageResponse
            quotas = try await quotaResponse
            activity = try await activityResponse
            loadError = nil
        } catch {
            app.handleAPIError(error)
            loadError = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}

// MARK: - Quota row

private struct QuotaRowView: View {
    let row: UserQuotaRow

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                AgentTypeIcon(type: row.type)
                Text(row.type).font(.callout)
                Spacer()
                Text(row.machineName)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if let error = row.error, row.windows.isEmpty {
                Text(error).font(.caption).foregroundStyle(.orange)
            }
            ForEach(row.windows, id: \.key) { window in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(window.label).font(.caption2).foregroundStyle(.secondary)
                        // Reset time inline — the web keeps this in a
                        // tooltip, but there's no hover here. Future-
                        // relative: "resets in 2 hr".
                        if let resetsAt = window.resetsAt {
                            Text("· resets \(RelativeTime.label(iso: resetsAt))")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        Text("\(Int(window.utilizationPercent))%")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    ProgressView(value: min(100, max(0, window.utilizationPercent)), total: 100)
                        .tint(tint(window.utilizationPercent))
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func tint(_ percent: Double) -> Color {
        if percent >= 85 { return .red }
        if percent >= 60 { return .orange }
        return .green
    }
}

// MARK: - Activity heatmap

/// GitHub-style contribution grid: 7 rows, one column per week, last
/// ~5 months. Cells SIZE TO FILL the container width (web parity — no
/// fixed-size cells leaving blank space), drawn in a Canvas whose
/// aspect ratio is derived from the column count so height follows
/// width automatically.
private struct ActivityHeatmap: View {
    let days: [ActivityDay]

    private let weekCount = 22
    /// Gap as a fraction of cell size — scales with the fill.
    private let gapRatio: CGFloat = 0.22

    var body: some View {
        let weeks = self.weeks
        let peak = maxCount
        let columns = CGFloat(max(1, weeks.count))
        let ratio = (columns + (columns - 1) * gapRatio) / (7 + 6 * gapRatio)
        Canvas { context, size in
            let cell = size.width / (columns + (columns - 1) * gapRatio)
            let gap = cell * gapRatio
            for (weekIndex, week) in weeks.enumerated() {
                for (dayIndex, day) in week.enumerated() {
                    let rect = CGRect(
                        x: CGFloat(weekIndex) * (cell + gap),
                        y: CGFloat(dayIndex) * (cell + gap),
                        width: cell,
                        height: cell
                    )
                    let path = Path(roundedRect: rect, cornerRadius: cell * 0.2)
                    context.fill(path, with: .color(color(for: day, peak: peak)))
                }
            }
        }
        .aspectRatio(ratio, contentMode: .fit)
        .frame(maxWidth: .infinity)
    }

    /// Chunk the trailing ~22 weeks into 7-day columns, phase-aligned so
    /// the last (partial) week sits in the final column.
    private var weeks: [[ActivityDay?]] {
        let tail = Array(days.suffix(weekCount * 7))
        guard !tail.isEmpty else { return [] }
        var columns: [[ActivityDay?]] = []
        var column: [ActivityDay?] = []
        // Pad the first column so weeks stay aligned to 7 rows.
        let remainder = tail.count % 7
        if remainder != 0 {
            column = Array(repeating: nil, count: 7 - remainder)
        }
        for day in tail {
            column.append(day)
            if column.count == 7 {
                columns.append(column)
                column = []
            }
        }
        if !column.isEmpty { columns.append(column) }
        return columns
    }

    private var maxCount: Int {
        max(1, days.map(\.count).max() ?? 1)
    }

    private func color(for day: ActivityDay?, peak: Int) -> Color {
        guard let day, day.count > 0 else {
            return Color.gray.opacity(day == nil ? 0 : 0.12)
        }
        let intensity = 0.25 + 0.75 * min(1, Double(day.count) / Double(peak))
        return Color.green.opacity(intensity)
    }
}

// MARK: - Activity curve

/// The web's ActivityLineChart: commands per day as a smoothed line
/// with a soft area fill, over the same dense /me/activity payload.
private struct ActivityCurve: View {
    let days: [ActivityDay]

    private static let dayParser: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    private var points: [(date: Date, count: Int)] {
        days.compactMap { day in
            Self.dayParser.date(from: day.date).map { ($0, day.count) }
        }
    }

    private var emerald: Color { Color(hex: 0x10B981) }

    var body: some View {
        Chart(points, id: \.date) { point in
            AreaMark(
                x: .value("Day", point.date),
                y: .value("Commands", point.count)
            )
            .interpolationMethod(.monotone)
            .foregroundStyle(
                .linearGradient(
                    colors: [emerald.opacity(0.25), emerald.opacity(0.02)],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            LineMark(
                x: .value("Day", point.date),
                y: .value("Commands", point.count)
            )
            .interpolationMethod(.monotone)
            .foregroundStyle(emerald)
            .lineStyle(StrokeStyle(lineWidth: 1.5))
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) {
                AxisGridLine()
                AxisValueLabel(format: .dateTime.month(.abbreviated))
            }
        }
        .frame(height: 150)
    }
}
