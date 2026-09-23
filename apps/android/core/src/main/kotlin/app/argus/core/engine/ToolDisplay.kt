package app.argus.core.engine

import app.argus.core.model.asString
import kotlinx.serialization.json.JsonObject

// Port of apps/ios/ArgusKit/Sources/ArgusKit/Engine/ToolDisplay.swift,
// itself a port of `describe()` in apps/web/src/components/ToolPill.tsx.
// Icon and colour choices (the web's `iconFor` / `iconColorFor`) stay in
// the UI layer, keyed off the tool name — this is only the text.

/**
 * Verb + argument for a tool row — a pure port of the web's
 * `ToolPill.describe()` (`apps/web/src/components/ToolPill.tsx`). Keeps
 * the transcript's tool phrasing identical across clients. Icon and
 * color choices stay in the UI layer (keyed off the tool name); this is
 * only the text.
 */
data class ToolDisplay(
    val verb: String,
    /** Primary argument (file path, command, query…), or null. */
    val argument: String? = null,
    /** Render the argument in a monospaced font (paths, commands). */
    val mono: Boolean = false,
) {
    companion object {
        /** Build the display for a tool name + its raw `meta.input`. */
        fun make(name: String?, input: JsonObject?): ToolDisplay {
            val lowered = (name ?: "").lowercase()
            val fields = input ?: JsonObject(emptyMap())

            // Argument sources, mirroring the web's field probes.
            val file = firstString(fields, "file_path", "filePath", "path", "filename")
            val pattern = firstString(fields, "pattern", "glob")
            val query = firstString(fields, "query", "search")
            val cmd = firstString(fields, "command", "cmd")
            val url = firstString(fields, "url")

            // A verb branch only fires when its field exists; otherwise
            // it falls out of the `when` to the default row below.
            when (lowered) {
                "read", "cat", "open" ->
                    if (file != null) return ToolDisplay("Read", file, mono = true)
                "write", "create" ->
                    if (file != null) return ToolDisplay("Wrote", file, mono = true)
                "edit", "patch", "multiedit" ->
                    if (file != null) return ToolDisplay("Edited", file, mono = true)
                "delete", "remove", "rm" ->
                    if (file != null) return ToolDisplay("Deleted", file, mono = true)
                "rename", "move", "mv" ->
                    if (file != null) return ToolDisplay("Renamed", file, mono = true)
                "grep" -> {
                    val arg = pattern ?: query
                    if (arg != null) return ToolDisplay("Searched codebase for", arg, mono = false)
                }
                "glob", "find", "ls" -> {
                    val arg = pattern ?: file
                    if (arg != null) return ToolDisplay("Listed", arg, mono = true)
                }
                "bash", "shell", "exec", "run" ->
                    if (cmd != null) return ToolDisplay("Ran", cmd, mono = true)
                "fetch", "webfetch" ->
                    if (url != null) return ToolDisplay("Fetched", url, mono = true)
                "websearch" ->
                    if (query != null) return ToolDisplay("Searched web for", query, mono = false)
                "task", "todo", "todowrite", "updatetodos" ->
                    return ToolDisplay("Updated todos")
                "taskcreate" ->
                    return ToolDisplay("Created task", firstString(fields, "subject"), mono = false)
                "taskupdate" -> {
                    val taskId = firstString(fields, "taskId")
                    val status = firstString(fields, "status")
                    val arg = listOfNotNull(taskId?.let { "#$it" }, status).joinToString(" → ")
                    return ToolDisplay("Updated task", arg.takeIf { it.isNotEmpty() }, mono = false)
                }
                "tasklist" ->
                    return ToolDisplay("Listed tasks")
                "taskget" ->
                    return ToolDisplay("Read task", firstString(fields, "taskId")?.let { "#$it" }, mono = false)
                "agent" -> {
                    val arg = firstString(fields, "description", "subagent_type")
                    return ToolDisplay("Sub-agent", arg, mono = false)
                }
                else -> Unit
            }

            // Default row: use the raw name as the verb, best-effort argument.
            val verb = if (!name.isNullOrEmpty()) name else "Called tool"
            val arg = file ?: pattern ?: query ?: cmd ?: url ?: fallbackArgument(fields)
            return ToolDisplay(verb, arg, mono = true)
        }

        /** First non-empty string among [keys], or null. */
        private fun firstString(input: JsonObject, vararg keys: String): String? {
            for (key in keys) {
                val value = input[key]?.asString
                if (!value.isNullOrEmpty()) return value
            }
            return null
        }

        /**
         * Last-resort argument for an unrecognized tool — the first short
         * string value in the input, so the row isn't verb-only.
         * (Iteration is insertion-ordered here; Swift's dictionary order
         * was unspecified.)
         */
        private fun fallbackArgument(input: JsonObject): String? {
            for ((_, value) in input) {
                val string = value.asString ?: continue
                if (string.isNotEmpty() && string.length <= 200) return string
            }
            return null
        }
    }
}
