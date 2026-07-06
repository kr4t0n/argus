import Foundation
import Observation
import ArgusKit

/// One parked follow-up prompt. Attachments are queued by their
/// already-uploaded server ids (like the web: object bytes live
/// server-side the moment they're picked, so queue entries survive
/// relaunch).
struct QueuedPrompt: Codable, Identifiable, Equatable {
    let id: UUID
    let sessionId: String
    var text: String
    var attachmentIds: [String]
    let createdAt: Date
}

/// Per-session FIFO of follow-up prompts, persisted so a backlog
/// survives relaunch (the web parks its queue in localStorage the same
/// way). Draining lives in AppModel — this is just ordered storage.
@MainActor
@Observable
final class QueueStore {
    private static let defaultsKey = "argus.queue.v1"

    private(set) var items: [QueuedPrompt] = []

    init() {
        load()
    }

    func items(for sessionId: String) -> [QueuedPrompt] {
        items.filter { $0.sessionId == sessionId }
    }

    func head(for sessionId: String) -> QueuedPrompt? {
        items.first { $0.sessionId == sessionId }
    }

    func enqueue(sessionId: String, text: String, attachmentIds: [String] = []) {
        items.append(QueuedPrompt(
            id: UUID(),
            sessionId: sessionId,
            text: text,
            attachmentIds: attachmentIds,
            createdAt: Date()
        ))
        save()
    }

    func update(id: UUID, text: String) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].text = text
        save()
    }

    func remove(id: UUID) {
        items.removeAll { $0.id == id }
        save()
    }

    func clear(sessionId: String) {
        items.removeAll { $0.sessionId == sessionId }
        save()
    }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
              let decoded = try? JSONDecoder().decode([QueuedPrompt].self, from: data)
        else { return }
        items = decoded
    }

    private func save() {
        if let data = try? JSONEncoder().encode(items) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
    }
}
