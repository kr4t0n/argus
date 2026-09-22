@file:OptIn(ExperimentalMaterial3Api::class)

package app.argus.android.ui.create

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.argus.android.AppModel
import app.argus.android.ui.components.AgentTypeGlyph
import app.argus.android.ui.session.Chevron
import app.argus.android.ui.session.ModelSelectionForm
import app.argus.android.ui.session.SectionHeader
import app.argus.android.ui.session.captionStyle
import app.argus.android.ui.session.monoStyle
import app.argus.android.ui.session.secondaryTextColor
import app.argus.android.ui.session.summary
import app.argus.core.api.ApiError
import app.argus.core.engine.ProjectGroup
import app.argus.core.model.AgentType
import app.argus.core.model.MachineDTO
import app.argus.core.model.ModelSelection
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

// Creation flows — the Android counterpart of the web's creation popovers
// (CreateSessionPopover / CreateProjectPopover) and a port of
// apps/ios/Argus/Sources/Views/CreateSheets.swift: the user picks an
// adapter + title (+ model) and AppModel.createSession posts the
// project-first shape (machineId + workingDir + cliType) — the server
// upserts the Project row and routes by machine × CLI runner. There is no
// separate "create project" call: a project IS its first session's
// (machineId, workingDir) pair.
//
// Both sheets are material3 ModalBottomSheets rather than the iOS
// NavigationStack forms, with one consequence for the "Model" row: it
// expands IN PLACE into the shared ModelSelectionForm instead of pushing
// a page, because a nested navigation page is awkward inside a bottom
// sheet on Android (the sheet has no stack to push onto).

/**
 * "+" on a project row → a new session inside that project.
 *
 * The project's `(machineId, workingDir)` pair is fixed by the row the
 * user tapped; only the adapter, an optional title and the model are
 * chosen here. The adapter list is filtered to what the sidecar
 * discovered on that machine's PATH (`MachineDTO.availableAdapters`),
 * the first one preselected, and changing it RESETS the model selection —
 * catalogs are per-CLI, so a selection from the previous adapter would be
 * meaningless. The orphan bucket (`machineId == null`) has nothing to
 * anchor a session against, so the sheet says so and disables Create.
 */
@Composable
fun NewSessionSheet(app: AppModel, project: ProjectGroup, onDismiss: () -> Unit) {
    val machines by app.fleet.machines.collectAsState()
    val machine: MachineDTO? = project.machineId?.let { machines[it] }
    val scope = rememberCoroutineScope()

    var adapterType by remember(project.id) { mutableStateOf<AgentType>("") }
    var title by remember(project.id) { mutableStateOf("") }
    var selection by remember(project.id) { mutableStateOf(ModelSelection()) }
    var busy by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    // First adapter preselected (the iOS onAppear). Keyed on the machine
    // row so a fleet list that hydrates after the sheet opens still seeds
    // it; the guard keeps a heartbeat re-render from clobbering a pick.
    LaunchedEffect(machine) {
        if (adapterType.isEmpty()) adapterType = machine?.availableAdapters?.firstOrNull()?.type ?: ""
    }

    fun create() {
        val machineId = project.machineId ?: return
        if (busy || adapterType.isEmpty()) return
        busy = true
        errorMessage = null
        scope.launch {
            try {
                app.createSession(
                    machineId = machineId,
                    workingDir = project.workingDir,
                    adapterType = adapterType,
                    title = title.trim(),
                    modelSelection = selection,
                )
                onDismiss()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                app.handleApiError(e)
                errorMessage = (e as? ApiError)?.message ?: e.message ?: "Couldn't create session"
            }
            busy = false
        }
    }

    CreateSheet(
        title = "New session",
        busy = busy,
        canCreate = project.machineId != null && adapterType.isNotEmpty(),
        errorMessage = errorMessage,
        onDismiss = onDismiss,
        onCreate = ::create,
    ) {
        ReadOnlyRow("Project", project.title)
        val machineName = machine?.name ?: project.machineName
        if (machineName.isNotEmpty()) ReadOnlyRow("Machine", machineName)

        if (project.machineId == null) {
            Text(
                "These sessions have no project to anchor a new one against — create it from a project row instead.",
                style = captionStyle(),
                color = secondaryTextColor,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
        } else {
            AdapterPickerSection(
                machine = machine,
                adapterType = adapterType,
                onPick = { type ->
                    if (type != adapterType) {
                        adapterType = type
                        // Catalogs are per-CLI — a selection from the
                        // previous adapter would be meaningless.
                        selection = ModelSelection()
                    }
                },
            )
            SectionHeader("Session")
            TitleField(title = title, onTitleChange = { title = it })
            ModelRow(
                app = app,
                machineId = project.machineId,
                adapterType = adapterType,
                selection = selection,
                onSelectionChange = { selection = it },
            )
        }
    }
}

/**
 * Machine panel → a new project: working dir + first session, on that
 * machine. The Project row is created server-side by the project-first
 * session POST — there is no project endpoint to call first.
 *
 * Web parity: projects are created FROM a machine (the machine list's
 * hover "+"), never from a global button that then asks which machine —
 * the machine is the natural entry point, so [machine] is passed in and
 * rendered as a locked display row; the sheet can't create a project on
 * a machine the user isn't looking at.
 *
 * The working directory becomes the CLI's cwd for every session in the
 * project and can never change afterwards (claude-code and cursor keep
 * resume state on disk keyed by it), hence the deliberately raw
 * monospace field: no autocorrect, no capitalisation, a URI keyboard for
 * the slashes.
 */
@Composable
fun NewProjectSheet(app: AppModel, machine: MachineDTO, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()

    var workingDir by remember(machine.id) { mutableStateOf("") }
    var adapterType by remember(machine.id) { mutableStateOf<AgentType>("") }
    var title by remember(machine.id) { mutableStateOf("") }
    var selection by remember(machine.id) { mutableStateOf(ModelSelection()) }
    var busy by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(machine) {
        if (adapterType.isEmpty()) adapterType = machine.availableAdapters.firstOrNull()?.type ?: ""
    }

    fun create() {
        val trimmedDir = workingDir.trim()
        if (busy || adapterType.isEmpty() || trimmedDir.isEmpty()) return
        busy = true
        errorMessage = null
        scope.launch {
            try {
                app.createSession(
                    machineId = machine.id,
                    workingDir = trimmedDir,
                    adapterType = adapterType,
                    title = title.trim(),
                    modelSelection = selection,
                )
                onDismiss()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                app.handleApiError(e)
                errorMessage = (e as? ApiError)?.message ?: e.message ?: "Couldn't create project"
            }
            busy = false
        }
    }

    CreateSheet(
        title = "New project",
        busy = busy,
        canCreate = adapterType.isNotEmpty() && workingDir.isNotBlank(),
        errorMessage = errorMessage,
        onDismiss = onDismiss,
        onCreate = ::create,
    ) {
        ReadOnlyRow("Machine", machine.name)

        SectionHeader("Working directory")
        OutlinedTextField(
            value = workingDir,
            onValueChange = { workingDir = it },
            placeholder = { Text("/home/me/projects/app", style = monoStyle(14.sp)) },
            textStyle = monoStyle(14.sp),
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Done,
            ),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        )

        AdapterPickerSection(
            machine = machine,
            adapterType = adapterType,
            onPick = { type ->
                if (type != adapterType) {
                    adapterType = type
                    selection = ModelSelection()
                }
            },
        )
        SectionHeader("First session")
        TitleField(title = title, onTitleChange = { title = it })
        ModelRow(
            app = app,
            machineId = machine.id,
            adapterType = adapterType,
            selection = selection,
            onSelectionChange = { selection = it },
        )
    }
}

// MARK: Shared pieces

/**
 * The sheet chrome both flows share: a title row, the caller's sections,
 * the error line and Cancel / Create — all in ONE scrolling column, so
 * an expanded model editor scrolls rather than overflowing, and
 * `imePadding` keeps the focused field above the keyboard. Cancel stays
 * enabled while busy: dismissing mid-request just drops the result.
 */
@Composable
private fun CreateSheet(
    title: String,
    busy: Boolean,
    canCreate: Boolean,
    errorMessage: String?,
    onDismiss: () -> Unit,
    onCreate: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(bottom = 24.dp),
        ) {
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            HorizontalDivider()

            content()

            errorMessage?.let {
                Text(
                    it,
                    style = captionStyle(),
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onDismiss) { Text("Cancel") }
                Spacer(Modifier.width(8.dp))
                Button(onClick = onCreate, enabled = !busy && canCreate) {
                    Text(if (busy) "Creating…" else "Create")
                }
            }
        }
    }
}

/** SwiftUI's `LabeledContent`: a label with its value trailing, dimmed. */
@Composable
private fun ReadOnlyRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.width(16.dp))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = secondaryTextColor,
            textAlign = TextAlign.End,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

/**
 * Adapter choice, filtered to what the sidecar discovered on that
 * machine's PATH — the same filter as the web's create popover. Radio
 * rows (the iOS inline picker), each leading with the CLI glyph and
 * trailing with the probed version. The web additionally offers a
 * free-text type when the machine reported nothing; iOS doesn't, and
 * neither does this — an unknown type has no runner to dispatch to.
 */
@Composable
private fun AdapterPickerSection(machine: MachineDTO?, adapterType: AgentType, onPick: (AgentType) -> Unit) {
    SectionHeader("Agent")
    val adapters = machine?.availableAdapters.orEmpty()
    if (adapters.isEmpty()) {
        Text(
            "No CLI agents discovered on this machine.",
            style = captionStyle(),
            color = secondaryTextColor,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
        return
    }
    for (adapter in adapters) {
        val selected = adapter.type == adapterType
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onPick(adapter.type) }
                .padding(start = 8.dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = selected, onClick = { onPick(adapter.type) })
            AgentTypeGlyph(type = adapter.type, size = 18)
            Spacer(Modifier.width(10.dp))
            Text(
                adapter.type,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (adapter.version.isNotEmpty()) {
                Text(adapter.version, style = captionStyle(), color = secondaryTextColor, maxLines = 1)
            }
        }
    }
}

/** The optional session title. */
@Composable
private fun TitleField(title: String, onTitleChange: (String) -> Unit) {
    OutlinedTextField(
        value = title,
        onValueChange = onTitleChange,
        label = { Text("Title (optional)") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
    )
}

/**
 * The create sheets' "Model" row: the current selection as a summary,
 * expanding in place into the shared catalog editor. Both the machine and
 * the adapter type are known right here, and catalogs are keyed
 * (machineId, cliType) since Phase 2 — resolvable before any session
 * exists. iOS pushes a page from this row; a bottom sheet has no
 * navigation stack, so this is a disclosure instead. Inert — no chevron,
 * no expansion — until an adapter is chosen, like the iOS row's
 * `.disabled(adapterType.isEmpty)`.
 *
 * The disclosure state survives an adapter switch; the form re-keys its
 * own catalog on the new `(machineId, cliType)` and the caller has
 * already reset the selection.
 */
@Composable
private fun ModelRow(
    app: AppModel,
    machineId: String?,
    adapterType: AgentType,
    selection: ModelSelection,
    onSelectionChange: (ModelSelection) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val enabled = adapterType.isNotEmpty()
    Column(modifier = Modifier.fillMaxWidth().animateContentSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = enabled) { expanded = !expanded }
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Model", style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.width(16.dp))
            Text(
                selection.summary,
                style = MaterialTheme.typography.bodyMedium,
                color = secondaryTextColor,
                textAlign = TextAlign.End,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (enabled) {
                Spacer(Modifier.width(8.dp))
                Chevron(open = expanded, size = 16.dp)
            }
        }
        if (expanded && enabled) {
            ModelSelectionForm(
                app = app,
                machineId = machineId,
                cliType = adapterType,
                selection = selection,
                onSelectionChange = onSelectionChange,
            )
        }
    }
}
