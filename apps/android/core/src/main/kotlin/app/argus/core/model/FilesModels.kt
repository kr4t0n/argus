package app.argus.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Mirrors packages/shared-types/src/protocol.ts (FSEntry / GitStatus /
// GitCommit) and api.ts (FSListResponse / FSReadResponse / GitLogResponse).

@Serializable(with = FSEntryKind.Serializer::class)
enum class FSEntryKind(override val wire: String) : WireEnum {
    FILE("file"),
    DIR("dir"),
    SYMLINK("symlink"),
    UNKNOWN("unknown");

    internal object Serializer : TolerantEnumSerializer<FSEntryKind>(
        "app.argus.core.FSEntryKind", entries, UNKNOWN,
    )
}

@Serializable
data class FSEntry(
    val name: String,
    val kind: FSEntryKind,
    val size: Long = 0,
    /** Unix millis. */
    val mtime: Long = 0,
    /** Only meaningful when the listing was requested with `showAll`. */
    val gitignored: Boolean? = null,
)

/**
 * Snapshot of the workingDir's git HEAD. [branch] is null in detached-HEAD
 * states; [head] is then the short SHA.
 */
@Serializable
data class GitStatus(
    val branch: String? = null,
    val head: String,
    val detached: Boolean = false,
)

/** `GET /projects/:id/fs/list`. */
@Serializable
data class FSListResponse(
    val path: String,
    val entries: List<FSEntry>,
    /**
     * Present when `depth > 1` was requested: path (relative to the
     * workingDir; "" = root) → that directory's listing.
     */
    val listings: Map<String, List<FSEntry>>? = null,
    val git: GitStatus? = null,
)

/**
 * `GET /projects/:id/fs/read` — discriminated union on `kind`. Unknown
 * kinds decode as [Unsupported] so a future server-side viewer type
 * degrades gracefully.
 */
@Serializable(with = FSReadResult.Serializer::class)
sealed interface FSReadResult {
    data class Text(val content: String, val size: Long) : FSReadResult
    data class Image(val mime: String, val base64: String, val size: Long) : FSReadResult
    data class Binary(val size: Long) : FSReadResult
    data class Unsupported(val kind: String) : FSReadResult

    object Serializer : KSerializer<FSReadResult> {
        override val descriptor: SerialDescriptor =
            buildClassSerialDescriptor("app.argus.core.FSReadResult")

        override fun deserialize(decoder: Decoder): FSReadResult {
            val json = decoder as? JsonDecoder
                ?: throw IllegalStateException("FSReadResult decodes from JSON only")
            val obj = json.decodeJsonElement().asObject ?: return Unsupported(kind = "")
            val kind = obj["kind"]?.asString ?: ""
            val size = obj["size"]?.asLong ?: 0
            return when (kind) {
                "text" -> Text(content = obj["content"]?.asString ?: "", size = size)
                "image" -> Image(
                    mime = obj["mime"]?.asString ?: "",
                    base64 = obj["base64"]?.asString ?: "",
                    size = size,
                )
                "binary" -> Binary(size = size)
                else -> Unsupported(kind = kind)
            }
        }

        override fun serialize(encoder: Encoder, value: FSReadResult) {
            val json = encoder as? JsonEncoder
                ?: throw IllegalStateException("FSReadResult encodes to JSON only")
            val obj: JsonObject = when (value) {
                is Text -> buildJsonObject {
                    put("kind", "text"); put("content", value.content); put("size", value.size)
                }
                is Image -> buildJsonObject {
                    put("kind", "image"); put("mime", value.mime)
                    put("base64", value.base64); put("size", value.size)
                }
                is Binary -> buildJsonObject { put("kind", "binary"); put("size", value.size) }
                is Unsupported -> buildJsonObject { put("kind", value.kind) }
            }
            json.encodeJsonElement(obj)
        }
    }
}

@Serializable
data class FSReadResponse(
    val path: String,
    val result: FSReadResult,
)

@Serializable
data class GitCommit(
    /** Full 40-char hash. */
    val sha: String,
    /** 7-char display form. */
    val shortSha: String,
    /** First line of the commit message. */
    val subject: String,
    val authorName: String = "",
    /** ISO-8601 author timestamp. */
    val authorDate: String = "",
)

/**
 * `GET /projects/:id/git/log`. Empty [commits] means "not a git repo" or a
 * fresh repo with no commits — render an empty state either way.
 */
@Serializable
data class GitLogResponse(
    val commits: List<GitCommit>,
    val git: GitStatus? = null,
)
