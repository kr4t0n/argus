package app.argus.android.ui.palette

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.android.HotkeyScope
import app.argus.android.Hotkeys
import app.argus.android.ui.session.monoStyle
import app.argus.android.ui.theme.argusPalette

/**
 * The Ctrl+/ shortcuts list — the web's ShortcutsHelp and the iOS
 * ShortcutsHelpSheet.
 *
 * It RENDERS [Hotkeys] rather than restating it, so a binding cannot
 * ship undocumented: dispatch takes a `HotkeyBinding`, and every
 * `HotkeyBinding` lives in the table this reads. The context-local keys
 * ([Hotkeys.localKeys]) are appended because a user asking "what can I
 * press" does not care which layer owns the handler.
 *
 * Rides `AppModel.paletteMode` like the palette (hosted by
 * [PaletteHost]), so Ctrl+P while this is up is a switch, not a second
 * sheet. This composable is the sheet's CONTENT only — the host owns the
 * presentation — which is why it takes an [onDismiss] instead of the
 * store.
 */
@Composable
fun ShortcutsHelpSheet(onDismiss: () -> Unit) {
    val global = Hotkeys.all.filter { it.scope == HotkeyScope.GLOBAL }
    val session = Hotkeys.all.filter { it.scope == HotkeyScope.SESSION }

    Column(modifier = Modifier.fillMaxWidth().fillMaxHeight()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Keyboard shortcuts",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onDismiss) { Text("Done") }
        }
        HorizontalDivider()

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            // "Anywhere" vs "In a session" is the `scope` field made
            // legible: a session binding is forwarded to the open session
            // screen and genuinely does nothing on the list.
            ShortcutGroup("Anywhere", global.map { it.chord to it.label })
            ShortcutGroup("In a session", session.map { it.chord to it.label })
            for (group in Hotkeys.localKeys) {
                ShortcutGroup(group.title, group.keys.map { it.chord to it.label })
            }
            Text(
                "Shortcuts need a hardware keyboard. Every binding is Ctrl-only on Android — " +
                    "the Meta (⌘/Win) key belongs to the system launcher and is never matched.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp, bottom = 16.dp),
            )
        }
    }
}

/** One titled section: uppercase caption, then label · keycap rows. */
@Composable
private fun ShortcutGroup(title: String, rows: List<Pair<String, String>>) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Text(
            title.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 4.dp),
        )
        for ((chord, label) in rows) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    label,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Keycap(chord)
            }
        }
    }
}

/** The web's `<Kbd>`: a chord in a small monospaced keycap. */
@Composable
internal fun Keycap(text: String) {
    Text(
        text,
        style = monoStyle(11.sp),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .background(argusPalette.surface2, RoundedCornerShape(4.dp))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}
