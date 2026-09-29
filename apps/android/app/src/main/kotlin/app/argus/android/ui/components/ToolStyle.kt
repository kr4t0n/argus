package app.argus.android.ui.components

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import app.argus.android.ui.theme.argusPalette

/**
 * Per-tool icon + tint, mirroring the web ToolPill's `iconFor` /
 * `iconColorFor` and the iOS `ToolStyle` in
 * apps/ios/Argus/Sources/Views/Components.swift. Keyed off the lowercased
 * tool name.
 *
 * Icons come from material-icons-core only (no extended set — see the
 * dependency posture in apps/android/README.md), so the SF Symbols / lucide
 * glyphs are mapped onto the nearest core shape:
 *
 * | tools                          | web (lucide)   | iOS (SF)            | here                      |
 * |--------------------------------|----------------|---------------------|---------------------------|
 * | read, cat, open                | FileText       | doc.text            | List (lines of text)      |
 * | write, create                  | FilePlus2      | doc.badge.plus      | Add                       |
 * | edit, patch, multiedit         | Pencil         | pencil              | Edit                      |
 * | delete, remove, rm             | Trash2         | trash               | Delete                    |
 * | rename, move, mv               | ArrowRightLeft | arrow.left.arrow.right | ArrowForward           |
 * | grep, search                   | Search         | magnifyingglass     | Search                    |
 * | glob, find, ls                 | FolderSearch   | folder.badge.questionmark | Search              |
 * | bash, shell, exec, run         | Terminal       | terminal            | KeyboardArrowRight (`>`)  |
 * | fetch, webfetch, websearch     | Globe          | globe               | Share (network nodes)     |
 * | task, todo, todowrite, task*   | ListTree       | list.bullet.indent  | CheckCircle               |
 * | agent                          | Bot            | cpu                 | Person                    |
 * | codebase, symbols              | FileCode2      | chevron.left.forwardslash… | Search             |
 * | (default)                      | Wrench         | wrench.and.screwdriver | Build                  |
 *
 * The glyph is decoration at 12–13 dp; the tint carries the grouping (blue
 * = read, violet = write, rose = delete, teal = search, emerald = shell,
 * indigo = network, orange = tasks, amber = sub-agent), which is why the
 * same core icon can stand in for two different SF Symbols.
 */
object ToolStyle {
    fun icon(rawName: String?): ImageVector = when ((rawName ?: "").lowercase()) {
        "read", "cat", "open" -> Icons.AutoMirrored.Filled.List
        "write", "create" -> Icons.Filled.Add
        "edit", "patch", "multiedit" -> Icons.Filled.Edit
        "delete", "remove", "rm" -> Icons.Filled.Delete
        "rename", "move", "mv" -> Icons.AutoMirrored.Filled.ArrowForward
        "grep", "search" -> Icons.Filled.Search
        "glob", "find", "ls" -> Icons.Filled.Search
        "bash", "shell", "exec", "run" -> Icons.AutoMirrored.Filled.KeyboardArrowRight
        "fetch", "webfetch", "websearch" -> Icons.Filled.Share
        "task", "todo", "todowrite", "updatetodos",
        "taskcreate", "taskupdate", "tasklist", "taskget" -> Icons.Filled.CheckCircle
        "agent" -> Icons.Filled.Person
        "codebase", "symbols" -> Icons.Filled.Search
        else -> Icons.Filled.Build
    }

    /**
     * The web's `iconColorFor`: exact tailwind tool colours (light -600 /
     * dark -400) at 70% opacity — dimmer than full-saturation system
     * colours. Default (unknown tool) is the muted foreground, NOT at 70%.
     */
    @Composable
    fun tint(rawName: String?): Color {
        val dark = argusPalette.isDark
        val base: Color = when ((rawName ?: "").lowercase()) {
            "read", "cat", "open", "codebase", "symbols" ->
                pick(dark, light = 0x2563EB, dark = 0x60A5FA) // blue
            "write", "create", "edit", "patch", "multiedit",
            "rename", "move", "mv" -> pick(dark, light = 0x7C3AED, dark = 0xA78BFA) // violet
            "delete", "remove", "rm" ->
                pick(dark, light = 0xE11D48, dark = 0xFB7185) // rose
            "grep", "search", "glob", "find", "ls" ->
                pick(dark, light = 0x0D9488, dark = 0x2DD4BF) // teal
            "bash", "shell", "exec", "run" ->
                pick(dark, light = 0x059669, dark = 0x34D399) // emerald
            "fetch", "webfetch", "websearch" ->
                pick(dark, light = 0x4F46E5, dark = 0x818CF8) // indigo
            "task", "todo", "todowrite", "updatetodos",
            "taskcreate", "taskupdate", "tasklist", "taskget" -> pick(dark, light = 0xEA580C, dark = 0xFB923C) // orange
            "agent" ->
                pick(dark, light = 0xD97706, dark = 0xFBBF24) // amber
            else -> return MaterialTheme.colorScheme.onSurfaceVariant // fg-muted, no /70
        }
        return base.copy(alpha = 0.7f)
    }

    private fun pick(isDark: Boolean, light: Long, dark: Long): Color =
        Color(0xFF000000L or (if (isDark) dark else light))
}
