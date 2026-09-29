package app.argus.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Mirrors packages/shared-types/src/protocol.ts (ModelSelection /
// ModelCatalog*) and api.ts (ModelCatalogResponse).
//
// Effort levels, context and speed facets are open strings on purpose:
// the server passes selections through to the CLI without validation, and
// the catalog is CLI-reported — new facet values must not break decoding.

/**
 * One model choice for a session or a single turn. All fields optional —
 * an empty selection means "CLI default".
 */
@Serializable
data class ModelSelection(
    /** Adapter-namespaced id; free text allowed (advanced escape hatch). */
    val model: String? = null,
    /** One of protocol.ts EFFORT_LEVELS ('none'…'max') when set. */
    val effort: String? = null,
    /** '1m' appends the `[1m]` suffix (claude-code only today). */
    val context: String? = null,
    /** 'fast' selects the priority service tier (codex only today). */
    val speed: String? = null,
) {
    val isEmpty: Boolean
        get() = model == null && effort == null && context == null && speed == null
}

@Serializable
data class ModelCatalogFacets(
    val effort: Effort? = null,
    val context: Context? = null,
    val speed: Speed? = null,
) {
    @Serializable
    data class Effort(
        val levels: List<String> = emptyList(),
        @SerialName("default") val defaultLevel: String = "",
    )

    @Serializable
    data class Context(
        /** 'default' | '1m' */
        val options: List<String> = emptyList(),
    )

    @Serializable
    data class Speed(
        /** 'standard' | 'fast' */
        val options: List<String> = emptyList(),
    )
}

@Serializable
data class ModelCatalogEntry(
    /**
     * Value for ModelSelection.model when chosen — always dispatched
     * exactly as-is, never recomposed.
     */
    val id: String,
    val displayName: String = "",
    val description: String? = null,
    /** Display metadata (tokens), informational only. */
    val contextWindow: Int? = null,
    /** The CLI's own default when no model flag is passed. */
    val isDefault: Boolean? = null,
    /** Grouping label for flat variant matrices (cursor-cli). */
    val family: String? = null,
    val variantLabel: String? = null,
    val facets: ModelCatalogFacets? = null,
)

/**
 * `GET /machines/:id/models?cliType=` — catalogs belong to the
 * machine's installed binary. Identity fields are optional for decode
 * tolerance across server versions; `?refresh=1` probes the CLI live.
 */
@Serializable
data class ModelCatalogResponse(
    /** 'static' | 'cli' */
    val source: String = "",
    /** Machine-route identity (machineId × cliType). */
    val machineId: String? = null,
    val cliType: String? = null,
    val fetchedAt: String = "",
    val models: List<ModelCatalogEntry> = emptyList(),
)
