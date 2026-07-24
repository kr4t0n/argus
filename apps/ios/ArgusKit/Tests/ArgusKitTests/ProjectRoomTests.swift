import Foundation
import Testing
@testable import ArgusKit

/// Project-room membership bookkeeping. These assert the MAP, not the
/// socket emissions — there's no connection in a unit test, so
/// `socket?.emit` is a no-op. The map is what decides whether an emit
/// happens at all, so it's the thing worth pinning.
@Suite("StreamClient — project room refcounting")
@MainActor
struct ProjectRoomTests {
    private let alpha = "machine-a"
    private let dir = "/home/kyle/projects/argus"

    @Test("a lone holder joins and leaves")
    func singleHolder() {
        let client = StreamClient()
        let key = ProjectRoomKey(machineId: alpha, workingDir: dir)

        client.joinProject(machineId: alpha, workingDir: dir)
        #expect(client.projectRooms[key] == 1)

        client.leaveProject(machineId: alpha, workingDir: dir)
        #expect(client.projectRooms[key] == nil)
    }

    /// The bug this whole type exists for: the inspector and the file
    /// preview sheet both hold the same room, and the inspector closing
    /// must NOT unsubscribe the sheet.
    @Test("a second holder survives the first one leaving")
    func overlappingHolders() {
        let client = StreamClient()
        let key = ProjectRoomKey(machineId: alpha, workingDir: dir)

        client.joinProject(machineId: alpha, workingDir: dir)
        client.joinProject(machineId: alpha, workingDir: dir)
        #expect(client.projectRooms[key] == 2)

        client.leaveProject(machineId: alpha, workingDir: dir)
        #expect(client.projectRooms[key] == 1, "room must survive while a holder remains")

        client.leaveProject(machineId: alpha, workingDir: dir)
        #expect(client.projectRooms[key] == nil, "last holder releases the room")
    }

    @Test("unbalanced leave doesn't wedge the count negative")
    func unbalancedLeave() {
        let client = StreamClient()
        let key = ProjectRoomKey(machineId: alpha, workingDir: dir)

        client.leaveProject(machineId: alpha, workingDir: dir)
        #expect(client.projectRooms[key] == nil)

        // A subsequent join must still work — a stray negative count
        // would suppress the subscribe emit forever.
        client.joinProject(machineId: alpha, workingDir: dir)
        #expect(client.projectRooms[key] == 1)
    }

    @Test("rooms are keyed by the machine + workingDir pair, independently")
    func distinctRooms() {
        let client = StreamClient()
        client.joinProject(machineId: alpha, workingDir: dir)
        client.joinProject(machineId: "machine-b", workingDir: dir)
        client.joinProject(machineId: alpha, workingDir: "/other")
        #expect(client.projectRooms.count == 3)

        client.leaveProject(machineId: alpha, workingDir: dir)
        #expect(client.projectRooms.count == 2)
        #expect(
            client.projectRooms[.init(machineId: "machine-b", workingDir: dir)] == 1,
            "leaving one pair must not disturb another"
        )
    }

    /// A struct key, not a joined string: `("a", "b/c")` and `("a/b", "c")`
    /// would collide under any single-separator concatenation.
    @Test("keys that would collide under string concatenation stay distinct")
    func keysDoNotCollide() {
        let client = StreamClient()
        client.joinProject(machineId: "a", workingDir: "b/c")
        client.joinProject(machineId: "a/b", workingDir: "c")
        #expect(client.projectRooms.count == 2)
    }

    /// Membership is per-connection, so tearing the socket down must
    /// clear the map — a surviving count would make the next
    /// `rejoinProjectRooms()` resubscribe rooms nobody holds, and would
    /// suppress the subscribe for a holder that legitimately re-joins.
    /// Exercised via `shutdown()` rather than `connect()`: both run the
    /// same teardown, and this one opens no socket.
    @Test("socket teardown clears membership")
    func teardownResetsRooms() {
        let client = StreamClient()
        client.joinProject(machineId: alpha, workingDir: dir)
        #expect(client.projectRooms.isEmpty == false)

        client.shutdown()
        #expect(client.projectRooms.isEmpty, "stale membership must not outlive the connection")
    }

    /// Replay is what makes a reconnect recover. It must not mutate the
    /// map — the holders haven't changed, only the connection has.
    @Test("rejoin leaves the refcounts untouched")
    func rejoinPreservesCounts() {
        let client = StreamClient()
        client.joinProject(machineId: alpha, workingDir: dir)
        client.joinProject(machineId: alpha, workingDir: dir)
        client.joinProject(machineId: "machine-b", workingDir: dir)

        let before = client.projectRooms
        client.rejoinProjectRooms()
        #expect(client.projectRooms == before)
    }
}
