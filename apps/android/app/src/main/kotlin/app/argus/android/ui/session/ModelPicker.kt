@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package app.argus.android.ui.session

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.argus.android.AppModel
import app.argus.core.api.ApiError
import app.argus.core.model.AgentType
import app.argus.core.model.ModelCatalogEntry
import app.argus.core.model.ModelCatalogResponse
import app.argus.core.model.ModelSelection
import app.argus.core.model.SessionDTO
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

// Model selection UI — the Android counterpart of the web's ModelPicker /
// SessionModelChip and a port of apps/ios/Argus/Sources/Views/ModelPicker.swift.
// One catalog-driven editor (`ModelSelectionForm`) with two callers, as on
// iOS: the ⋯ menu's sheet for an EXISTING session's default
// (`ModelPickerSheet`, saved via PATCH /sessions/:id/model on confirm) and
// the create sheets' inline "Model" row (ui/create/CreateSheets.kt), where
// the selection rides the project-first session POST instead.
//
// Two invariants from the design: "CLI default" (an empty selection) is
// always first and means "pass no model flags" — the CLI decides, identical
// to pre-picker behaviour; and the catalog constrains the UI but never the
// dispatch: a custom free-text model id is always available (and is the
// only path when the catalog can't be resolved), and whatever is selected
// passes through to the CLI opaquely. Model catalogs describe, they never
// gate (AGENTS.md).

/** Short human summary, e.g. "opus · high · 1M" / "CLI default". */
val ModelSelection.summary: String
    get() {
        val parts = ArrayList<String>(4)
        model?.let { parts += it }
        effort?.let { parts += it }
        if (context == "1m") parts += "1M"
        if (speed == "fast") parts += "fast"
        return if (parts.isEmpty()) "CLI default" else parts.joinToString(" · ")
    }

/**
 * Change an existing session's default model — the ⋯ menu's "Model…"
 * sheet. Saves via PATCH /sessions/:id/model on confirm and upserts the
 * returned row so the header chip updates without a refetch.
 *
 * The catalog is keyed `(machineId, cliType)` — it belongs to the
 * machine's installed binary, not to a workdir-bound agent — so it loads
 * through the session's pinned project. A null machineId (workdir-less
 * session, or the Project row not hydrated yet) means the target machine
 * is unknown: the form degrades to custom-id only rather than failing.
 *
 * The selection is seeded ONCE from the session row: a `session:updated`
 * echo mid-edit (the row re-rendering under the sheet) must not reset
 * what the user is choosing. The editor itself is [ModelSelectionForm];
 * this sheet only owns the selection and the save.
 */
@Composable
fun ModelPickerSheet(app: AppModel, session: SessionDTO, onDismiss: () -> Unit) {
    val projects by app.fleet.projects.collectAsState()
    val machineId: String? = remember(session.projectId, projects) { app.fleet.projectRef(session)?.machineId }
    val cliType: AgentType = session.cliType ?: ""
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()

    var selection by remember(session.id) { mutableStateOf(session.modelSelection ?: ModelSelection()) }
    var saving by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf<String?>(null) }

    fun save() {
        val client = app.client ?: return
        if (saving) return
        saving = true
        saveError = null
        scope.launch {
            try {
                val updated = client.setSessionModel(session.id, selection.takeUnless { it.isEmpty })
                app.sessionList.upsert(updated)
                onDismiss()
            } catch (e: Exception) {
                app.handleApiError(e)
                saveError = (e as? ApiError)?.message ?: e.message ?: "Couldn't save"
            }
            saving = false
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(modifier = Modifier.fillMaxWidth().fillMaxHeight(0.9f).imePadding()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Model", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = onDismiss, enabled = !saving) { Text("Cancel") }
                TextButton(onClick = { save() }, enabled = !saving) { Text("Save") }
            }
            HorizontalDivider()

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(bottom = 16.dp),
            ) {
                ModelSelectionForm(
                    app = app,
                    machineId = machineId,
                    cliType = cliType,
                    selection = selection,
                    onSelectionChange = { selection = it },
                )

                saveError?.let {
                    Text(
                        it,
                        style = captionStyle(),
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
            }
        }
    }
}

/**
 * The catalog-driven editor: "CLI default" / catalog rows grouped by family /
 * custom id / facets of the selected entry, with load + refresh state. Owns
 * its catalog fetch; the caller owns the selection — the iOS
 * `ModelSelectionForm` shape (a binding in, no navigation of its own), so
 * the same rows serve an existing session's sheet and the create sheets'
 * inline "Model" row. A plain Column: the caller provides the scroll.
 *
 * The catalog is keyed `(machineId, cliType)` — it belongs to the machine's
 * installed binary, not to any session — which is what makes it
 * resolvable before a session exists. A null [machineId] (workdir-less
 * session, Project row not hydrated yet, the orphan bucket) or an empty
 * [cliType] means the target is unknown: the form degrades to custom-id
 * only rather than failing.
 *
 * Every piece of per-target state is keyed on that pair: a create sheet
 * switching adapters must not show the previous CLI's catalog under the
 * new one while the fetch is in flight (the caller resets the selection at
 * the same moment — catalogs are per-CLI). The custom-id field is seeded
 * from the incoming selection only when no catalog can ever answer;
 * otherwise the load decides whether the model is a catalog entry or a
 * custom id. Sticky custom mode: once the user types a custom id the field
 * owns the selection even while the catalog would recognise it.
 *
 * Refresh sits in the Models header — the one path that forces a live CLI
 * probe (`?refresh=1`). A failed refresh keeps the current list up (web
 * parity); only a cold failure leaves the form catalog-less.
 */
@Composable
fun ModelSelectionForm(
    app: AppModel,
    machineId: String?,
    cliType: String,
    selection: ModelSelection,
    onSelectionChange: (ModelSelection) -> Unit,
    modifier: Modifier = Modifier,
) {
    val catalogResolvable = machineId != null && cliType.isNotEmpty()
    val scope = rememberCoroutineScope()
    // The load reads the selection AFTER its round trip: go through the
    // latest value, not the one captured when the effect launched.
    val currentSelection by rememberUpdatedState(selection)

    var customModel by remember(machineId, cliType) {
        mutableStateOf(if (catalogResolvable) "" else selection.model ?: "")
    }
    var catalog by remember(machineId, cliType) { mutableStateOf<ModelCatalogResponse?>(null) }
    var loading by remember(machineId, cliType) { mutableStateOf(false) }
    var refreshing by remember(machineId, cliType) { mutableStateOf(false) }
    var loadError by remember(machineId, cliType) { mutableStateOf<String?>(null) }

    suspend fun load(refresh: Boolean) {
        val client = app.client ?: return
        val target = machineId ?: return
        if (cliType.isEmpty()) return
        if (refresh) refreshing = true else loading = true
        loadError = null
        try {
            val response = client.getMachineModelCatalog(target, cliType, refresh = refresh)
            catalog = response
            // A pre-set model id that isn't in the catalog is a custom id.
            val model = currentSelection.model
            if (model != null && customModel.isEmpty() && response.models.none { it.id == model }) {
                customModel = model
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // A failed refresh keeps the current list up (web parity);
            // only a cold failure leaves the form catalog-less.
            app.handleApiError(e)
            loadError = (e as? ApiError)?.message ?: e.message ?: "Couldn't load models"
        }
        loading = false
        refreshing = false
    }

    LaunchedEffect(machineId, cliType) { load(refresh = false) }

    val selectedEntry: ModelCatalogEntry? = if (customModel.isEmpty()) {
        selection.model?.let { id -> catalog?.models?.firstOrNull { it.id == id } }
    } else {
        null
    }

    fun pick(entry: ModelCatalogEntry) {
        customModel = ""
        // Reset facets to the entry's defaults (iOS parity): the effort
        // picker needs a concrete level to show as chosen.
        onSelectionChange(
            ModelSelection(
                model = entry.id,
                effort = entry.facets?.effort?.defaultLevel?.takeIf { it.isNotEmpty() },
            ),
        )
    }

    Column(modifier = modifier.fillMaxWidth()) {
        SelectableRow(
            title = "CLI default",
            subtitle = "Pass no model flags — the CLI decides",
            selected = selection.model == null && customModel.isEmpty(),
            onClick = {
                customModel = ""
                onSelectionChange(ModelSelection())
            },
        )

        if (catalogResolvable) {
            // Section header with the manual refresh. The current list
            // stays interactive throughout a refresh.
            Row(
                modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "MODELS",
                    style = MaterialTheme.typography.labelSmall,
                    color = secondaryTextColor,
                    modifier = Modifier.weight(1f),
                )
                IconButton(
                    onClick = { scope.launch { load(refresh = true) } },
                    enabled = !refreshing && !loading,
                    modifier = Modifier.size(28.dp),
                ) {
                    if (refreshing) {
                        CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(
                            Icons.Default.Refresh,
                            contentDescription = "Refresh model list",
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }

        val loaded = catalog
        when {
            loaded != null -> CatalogRows(
                catalog = loaded,
                selectedId = selectedEntry?.id,
                onPick = ::pick,
            )
            !catalogResolvable -> Text(
                "No machine or CLI resolved for this session yet — the model catalog appears once they are. " +
                    "A custom model id below still works.",
                style = captionStyle(),
                color = secondaryTextColor,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            loadError != null -> Text(
                "Model list unavailable: $loadError",
                style = captionStyle(),
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            else -> Row(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                horizontalArrangement = Arrangement.Center,
            ) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
            }
        }
        // A refresh that failed after a successful load: the list
        // above stays, the reason is surfaced under it.
        if (loaded != null && loadError != null) {
            Text(
                "Refresh failed: $loadError",
                style = captionStyle(),
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }

        selectedEntry?.facets?.let { facets ->
            val effort = facets.effort
            val hasEffort = effort != null && effort.levels.isNotEmpty()
            val hasContext = facets.context?.options?.contains("1m") == true
            val hasSpeed = facets.speed?.options?.contains("fast") == true
            if (hasEffort || hasContext || hasSpeed) {
                SectionHeader("Options")
                if (effort != null && hasEffort) {
                    Text(
                        "Effort",
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                    val current = selection.effort ?: effort.defaultLevel
                    FlowRow(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        for (level in effort.levels) {
                            FilterChip(
                                selected = level == current,
                                onClick = { onSelectionChange(selection.copy(effort = level)) },
                                label = { Text(level) },
                            )
                        }
                    }
                }
                if (hasContext) {
                    SwitchRow(
                        title = "1M context window",
                        subtitle = "May require a plan upgrade or usage credits",
                        checked = selection.context == "1m",
                        onCheckedChange = { onSelectionChange(selection.copy(context = if (it) "1m" else null)) },
                    )
                }
                if (hasSpeed) {
                    SwitchRow(
                        title = "Fast service tier",
                        subtitle = "Priority processing",
                        checked = selection.speed == "fast",
                        onCheckedChange = { onSelectionChange(selection.copy(speed = if (it) "fast" else null)) },
                    )
                }
            }
        }

        SectionHeader("Custom")
        OutlinedTextField(
            value = customModel,
            onValueChange = { text ->
                customModel = text
                val trimmed = text.trim()
                // Clearing the field returns to "CLI default" rather
                // than leaving the last typed id armed for Save
                // (a deliberate tightening over the iOS form).
                onSelectionChange(if (trimmed.isEmpty()) ModelSelection() else ModelSelection(model = trimmed))
            },
            label = { Text("Custom model id") },
            placeholder = { Text("Passed to the CLI verbatim") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                imeAction = ImeAction.Done,
            ),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        )
    }
}

/**
 * The catalog as rows under the form's Models header: entries without a
 * `family` are flat (claude-code, codex); entries sharing one collapse
 * under a family sub-header (cursor-cli's slug matrix), each row showing
 * its variant label. Order is the catalog's own — the CLI lists its
 * default first.
 */
@Composable
private fun CatalogRows(
    catalog: ModelCatalogResponse,
    selectedId: String?,
    onPick: (ModelCatalogEntry) -> Unit,
) {
    val flat = catalog.models.filter { it.family == null }
    // groupBy keeps first-seen key order, so families render in catalog order.
    val families = catalog.models.filter { it.family != null }.groupBy { it.family!! }

    for (entry in flat) {
        SelectableRow(
            title = entry.displayName.ifEmpty { entry.id },
            subtitle = entrySubtitle(entry),
            selected = entry.id == selectedId,
            onClick = { onPick(entry) },
        )
    }
    for ((family, members) in families) {
        SectionHeader(family)
        for (entry in members) {
            SelectableRow(
                title = entry.variantLabel ?: entry.displayName.ifEmpty { entry.id },
                subtitle = entrySubtitle(entry),
                selected = entry.id == selectedId,
                onClick = { onPick(entry) },
            )
        }
    }
}

/** "CLI default" beats the description; the window rides along when known. */
private fun entrySubtitle(entry: ModelCatalogEntry): String? {
    val parts = ArrayList<String>(2)
    // Local copy: a nullable property declared in another module can't be
    // smart-cast, so the null check has to run on a local val.
    val description = entry.description
    if (entry.isDefault == true) {
        parts += "CLI default"
    } else if (!description.isNullOrEmpty()) {
        parts += description
    }
    entry.contextWindow?.takeIf { it > 0 }?.let { parts += "${compactCount(it)} context" }
    return if (parts.isEmpty()) null else parts.joinToString(" · ")
}

/** Uppercase section label for form-style sheets (shared with the create sheets). */
@Composable
internal fun SectionHeader(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = secondaryTextColor,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp),
    )
}

/** A radio-led row; the whole row is the tap target. */
@Composable
private fun SelectableRow(title: String, subtitle: String?, selected: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(start = 8.dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = onClick)
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!subtitle.isNullOrEmpty()) {
                Text(subtitle, style = captionStyle(), color = secondaryTextColor, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun SwitchRow(title: String, subtitle: String?, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onCheckedChange(!checked) }
            .padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium)
            if (!subtitle.isNullOrEmpty()) Text(subtitle, style = captionStyle(), color = secondaryTextColor)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}
