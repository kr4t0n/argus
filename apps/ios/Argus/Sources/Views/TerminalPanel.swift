import SwiftUI
import SwiftTerm
import UIKit
import ArgusKit

/// Owns one PTY session: opens it over REST, joins its socket room,
/// bridges SwiftTerm's TerminalView to the terminal:* events (base64
/// bytes both ways, duplicate-seq guard on output — the same rules as
/// the web's TerminalPane/xterm). Held by InspectorPane so switching
/// tabs doesn't kill the shell; shut down when the inspector goes away.
@MainActor
@Observable
final class TerminalController {
    enum State: Equatable {
        case idle
        case connecting
        case open
        case closed(String)
        case failed(String)
    }

    private(set) var state: State = .idle

    /// The PTY's project (machine + cwd). Nil only for workdir-less
    /// sessions, which have no terminal surface.
    let project: ProjectRef?
    /// One UIKit view for the controller's lifetime — keeping it (not
    /// recreating per SwiftUI update) is what preserves scrollback
    /// across tab switches.
    let terminalView: SwiftTerm.TerminalView

    private let client: ArgusClient
    private let stream: StreamClient
    private var terminalId: String?
    private var lastSeq = -1
    private let delegateBridge = TerminalDelegateBridge()

    init(project: ProjectRef?, client: ArgusClient, stream: StreamClient) {
        self.project = project
        self.client = client
        self.stream = stream
        self.terminalView = SwiftTerm.TerminalView(frame: CGRect(x: 0, y: 0, width: 320, height: 240))
        delegateBridge.controller = self
        terminalView.terminalDelegate = delegateBridge
    }

    /// User-driven open — the tab shows a CTA instead of auto-attaching
    /// (web parity: visiting the pane must not spawn a PTY you didn't
    /// ask for). Also the retry/new-shell path: a fresh PTY has a fresh
    /// seq stream.
    func open() async {
        guard state != .connecting, state != .open else { return }
        lastSeq = -1
        await start()
    }

    /// User-driven close (the power button) — the web's "close shell".
    /// Same WS close as the inspector-disappear reap; back to the CTA.
    func closeShell() {
        shutdown()
    }

    /// Drop a settled "Shell ended" banner back to the CTA without
    /// opening a new PTY (the web's dismiss).
    func dismissToIdle() {
        guard case .closed = state else { return }
        state = .idle
    }

    private func start() async {
        state = .connecting
        do {
            let term = terminalView.getTerminal()
            let cols = max(2, term.cols)
            let rows = max(2, term.rows)
            // Terminals are project-addressed (a (machine, cwd) pair); a
            // session with no project has no terminal surface.
            guard let project else {
                state = .failed("this session isn't pinned to a project")
                return
            }
            let dto = try await client.openProjectTerminal(
                projectId: project.projectId, cols: cols, rows: rows
            )
            terminalId = dto.id
            stream.joinTerminal(dto.id)
            state = .open
        } catch {
            state = .failed((error as? APIError)?.message ?? error.localizedDescription)
        }
    }

    /// WS close + leave; the server records the close and the sidecar
    /// reaps the shell.
    func shutdown() {
        guard let terminalId else { return }
        stream.sendTerminalClose(terminalId: terminalId)
        stream.leaveTerminal(terminalId)
        self.terminalId = nil
        state = .idle
    }

    /// Socket.IO rooms don't survive reconnects. Output produced during
    /// the gap is lost (same as the web) but the shell itself lives on.
    func handleReconnect() {
        guard let terminalId else { return }
        stream.joinTerminal(terminalId)
    }

    func handle(_ event: ServerEvent) {
        switch event {
        case .terminalOutput(let output):
            guard output.terminalId == terminalId, output.seq > lastSeq else { return }
            lastSeq = output.seq
            if let data = Data(base64Encoded: output.data) {
                terminalView.feed(byteArray: ArraySlice([UInt8](data)))
            }
        case .terminalClosed(let closed):
            guard closed.terminalId == terminalId else { return }
            stream.leaveTerminal(closed.terminalId)
            terminalId = nil
            let code = closed.exitCode.map { " (exit \($0))" } ?? ""
            state = .closed("Shell ended\(code)")
        default:
            break
        }
    }

    // Called by the delegate bridge (SwiftTerm invokes on main).

    fileprivate func sendInput(_ bytes: ArraySlice<UInt8>) {
        guard let terminalId else { return }
        stream.sendTerminalInput(
            terminalId: terminalId,
            base64Data: Data(bytes).base64EncodedString()
        )
    }

    fileprivate func sendResize(cols: Int, rows: Int) {
        guard let terminalId else { return }
        stream.sendTerminalResize(terminalId: terminalId, cols: cols, rows: rows)
    }
}

/// SwiftTerm's delegate methods are nonisolated protocol requirements;
/// this NSObject bridge hops them onto the MainActor controller. Kept
/// separate so TerminalController can stay a plain @Observable class.
/// @unchecked Sendable: the only state is a weak reference assigned
/// once at init (before any callback can fire), and every callback
/// immediately hops to the MainActor — the send/sizeChanged closures
/// need to carry `self` across that hop.
private final class TerminalDelegateBridge: NSObject, TerminalViewDelegate, @unchecked Sendable {
    weak var controller: TerminalController?

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        let bytes = data
        Task { @MainActor in self.controller?.sendInput(bytes) }
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        Task { @MainActor in self.controller?.sendResize(cols: newCols, rows: newRows) }
    }

    func setTerminalTitle(source: TerminalView, title: String) {}

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    func scrolled(source: TerminalView, position: Double) {}

    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link) else { return }
        Task { @MainActor in UIApplication.shared.open(url) }
    }

    func bell(source: TerminalView) {}

    func clipboardCopy(source: TerminalView, content: Data) {
        if let text = String(data: content, encoding: .utf8) {
            Task { @MainActor in UIPasteboard.general.string = text }
        }
    }

    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}

    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

/// Embeds the controller's long-lived TerminalView.
private struct TerminalHostView: UIViewRepresentable {
    let terminalView: SwiftTerm.TerminalView

    func makeUIView(context: Context) -> SwiftTerm.TerminalView { terminalView }
    func updateUIView(_ uiView: SwiftTerm.TerminalView, context: Context) {}
}

/// The inspector's Terminal tab. The PTY grants shell access as the
/// sidecar user — it only exists for projects whose runner has the
/// terminal opt-in, and the server scopes each terminal to the opening
/// user.
///
/// Lifecycle is explicit, like the web TerminalPane: idle shows an
/// "Open shell" CTA (no auto-attach), an open shell gets a close
/// (power) button, and a settled shell offers Dismiss / New shell. The
/// one divergence: the inspector-disappear reap stays — on a phone an
/// orphaned PTY with no visible re-attach surface is worse than the
/// web's leave-it-running stance.
struct TerminalPanel: View {
    @Environment(AppModel.self) private var app
    let controller: TerminalController

    var body: some View {
        VStack(spacing: 0) {
            switch controller.state {
            case .idle:
                ContentUnavailableView {
                    Label("No shell", systemImage: "terminal")
                } description: {
                    Text("Attach a shell on \(machineName).")
                } actions: {
                    Button("Open shell") {
                        Task { await controller.open() }
                    }
                }
            case .connecting:
                ProgressView("Opening shell…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ContentUnavailableView {
                    Label("Couldn't open terminal", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Try again") {
                        Task { await controller.open() }
                    }
                }
            case .open, .closed:
                if controller.state == .open {
                    HStack {
                        Spacer()
                        Button {
                            controller.closeShell()
                        } label: {
                            Image(systemName: "power")
                        }
                        .help("Close shell")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    Divider()
                }
                TerminalHostView(terminalView: controller.terminalView)
                if case .closed(let message) = controller.state {
                    HStack {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Dismiss") {
                            controller.dismissToIdle()
                        }
                        .font(.caption)
                        Button("New shell") {
                            Task { await controller.open() }
                        }
                        .font(.caption)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.quaternary.opacity(0.4))
                }
            }
        }
    }

    private var machineName: String {
        controller.project.flatMap { app.fleet.machines[$0.machineId]?.name } ?? "the machine"
    }
}
