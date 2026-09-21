package app.argus.core.realtime

/**
 * Identifies one project room. A data class rather than a joined string
 * so there's no separator for a `workingDir` to collide on —
 * `("a", "b/c")` and `("a/b", "c")` are distinct rooms.
 */
data class ProjectRoomKey(val machineId: String, val workingDir: String)

/**
 * Held project rooms → holder count. A REFCOUNT, not a flag: the
 * inspector, the file-preview sheet, and anything else wanting
 * `fs:changed` subscribe independently, and Socket.IO's `leave` is not
 * refcounted — so without this the first holder to disappear
 * unsubscribes the socket out from under the others.
 *
 * Pure bookkeeping (no socket), so it is unit-testable on its own; the
 * return values tell [StreamClient] whether an emit is due. Doubles as
 * the replay list for a reconnect.
 */
class ProjectRoomRegistry {
    private val holders = LinkedHashMap<ProjectRoomKey, Int>()

    /** Registers a holder; true when this is the FIRST one (subscribe now). */
    fun join(key: ProjectRoomKey): Boolean {
        val count = (holders[key] ?: 0) + 1
        holders[key] = count
        return count == 1
    }

    /**
     * Releases a holder; true when the room is now empty (unsubscribe
     * now). An unbalanced leave never wedges the count negative — the
     * entry is simply dropped, so a later join subscribes again.
     */
    fun leave(key: ProjectRoomKey): Boolean {
        val count = (holders[key] ?: 0) - 1
        if (count > 0) {
            holders[key] = count
            return false
        }
        holders.remove(key)
        return true
    }

    /** Every held room, for replay after a reconnect. */
    fun keys(): List<ProjectRoomKey> = holders.keys.toList()

    fun snapshot(): Map<ProjectRoomKey, Int> = LinkedHashMap(holders)

    fun clear() = holders.clear()
}
