package app.argus.core.realtime

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Project-room membership bookkeeping. These assert the MAP, not the
 * socket emissions — there's no connection in a unit test, so the emits
 * are no-ops. The map is what decides whether an emit happens at all, so
 * it's the thing worth pinning. (Port of ProjectRoomTests.swift.)
 */
class ProjectRoomTest {
    private val alpha = "machine-a"
    private val dir = "/home/kyle/projects/argus"

    @Test
    fun `a lone holder joins and leaves`() {
        val client = StreamClient()
        val key = ProjectRoomKey(alpha, dir)

        client.joinProject(alpha, dir)
        assertEquals(1, client.projectRooms[key])

        client.leaveProject(alpha, dir)
        assertNull(client.projectRooms[key])
    }

    /**
     * The bug this whole type exists for: the inspector and the file
     * preview sheet both hold the same room, and the inspector closing
     * must NOT unsubscribe the sheet.
     */
    @Test
    fun `a second holder survives the first one leaving`() {
        val client = StreamClient()
        val key = ProjectRoomKey(alpha, dir)

        client.joinProject(alpha, dir)
        client.joinProject(alpha, dir)
        assertEquals(2, client.projectRooms[key])

        client.leaveProject(alpha, dir)
        assertEquals(1, client.projectRooms[key], "room must survive while a holder remains")

        client.leaveProject(alpha, dir)
        assertNull(client.projectRooms[key], "last holder releases the room")
    }

    @Test
    fun `unbalanced leave doesn't wedge the count negative`() {
        val client = StreamClient()
        val key = ProjectRoomKey(alpha, dir)

        client.leaveProject(alpha, dir)
        assertNull(client.projectRooms[key])

        // A subsequent join must still work — a stray negative count
        // would suppress the subscribe emit forever.
        client.joinProject(alpha, dir)
        assertEquals(1, client.projectRooms[key])
    }

    @Test
    fun `rooms are keyed by the machine + workingDir pair, independently`() {
        val client = StreamClient()
        client.joinProject(alpha, dir)
        client.joinProject("machine-b", dir)
        client.joinProject(alpha, "/other")
        assertEquals(3, client.projectRooms.size)

        client.leaveProject(alpha, dir)
        assertEquals(2, client.projectRooms.size)
        assertEquals(
            1,
            client.projectRooms[ProjectRoomKey("machine-b", dir)],
            "leaving one pair must not disturb another",
        )
    }

    /**
     * A data-class key, not a joined string: `("a", "b/c")` and
     * `("a/b", "c")` would collide under any single-separator concatenation.
     */
    @Test
    fun `keys that would collide under string concatenation stay distinct`() {
        val client = StreamClient()
        client.joinProject("a", "b/c")
        client.joinProject("a/b", "c")
        assertEquals(2, client.projectRooms.size)
    }

    /**
     * Membership is per-connection, so tearing the socket down must
     * clear the map — a surviving count would make the next
     * rejoinProjectRooms() resubscribe rooms nobody holds, and would
     * suppress the subscribe for a holder that legitimately re-joins.
     * Exercised via shutdown() rather than connect(): both run the same
     * teardown, and this one opens no socket.
     */
    @Test
    fun `socket teardown clears membership`() {
        val client = StreamClient()
        client.joinProject(alpha, dir)
        assertFalse(client.projectRooms.isEmpty())

        client.shutdown()
        assertTrue(client.projectRooms.isEmpty(), "stale membership must not outlive the connection")
    }

    /**
     * Replay is what makes a reconnect recover. It must not mutate the
     * map — the holders haven't changed, only the connection has.
     */
    @Test
    fun `rejoin leaves the refcounts untouched`() {
        val client = StreamClient()
        client.joinProject(alpha, dir)
        client.joinProject(alpha, dir)
        client.joinProject("machine-b", dir)

        val before = client.projectRooms
        client.rejoinProjectRooms()
        assertEquals(before, client.projectRooms)
    }

    @Test
    fun `the registry reports the subscribe and unsubscribe edges`() {
        val registry = ProjectRoomRegistry()
        val key = ProjectRoomKey(alpha, dir)
        assertTrue(registry.join(key), "first holder subscribes")
        assertFalse(registry.join(key), "second holder is already covered")
        assertFalse(registry.leave(key), "one holder remains")
        assertTrue(registry.leave(key), "last holder unsubscribes")
        assertTrue(registry.leave(key), "an unbalanced leave still reports the edge and never goes negative")
        assertTrue(registry.keys().isEmpty())
    }
}
