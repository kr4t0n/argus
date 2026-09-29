package app.argus.core.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

// Serialization support shared by every wire model. Three concerns live
// here, all in service of decode tolerance (see ArgusJson):
//
//   1. TolerantEnumSerializer — an unrecognised wire value becomes the
//      enum's fallback member instead of failing the payload. Written as
//      an explicit serializer rather than relying on coerceInputValues,
//      which only coerces when the PROPERTY declares a default: one
//      forgotten `= UNKNOWN` would silently reintroduce strict decoding.
//   2. EpochMillisSerializer — ResultChunk.ts arrives as Unix millis on
//      WS relays and as an ISO string on REST rows; one field, one
//      serializer, both dressings.
//   3. Tolerant accessors over JsonElement — the Kotlin stand-in for
//      ArgusKit's JSONValue. `ResultChunk.meta` and `Command.options`
//      carry raw upstream CLI events whose shape drifts between CLI
//      versions; everything the engine reads out of them goes through
//      these, so an unexpected shape degrades to null, never to a throw.

/** Implemented by every wire enum: the exact string the server sends. */
interface WireEnum {
    val wire: String
}

/**
 * Decodes a string enum, mapping unknown values to [fallback]. When the
 * decoder is a [JsonDecoder] the whole element is consumed first, so a
 * non-string value (`null`, a number) also lands on the fallback rather
 * than leaving the decoder mid-token.
 */
open class TolerantEnumSerializer<T>(
    serialName: String,
    private val entries: List<T>,
    private val fallback: T,
) : KSerializer<T> where T : Enum<T>, T : WireEnum {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor(serialName, PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): T {
        val raw: String? = if (decoder is JsonDecoder) {
            decoder.decodeJsonElement().asString
        } else {
            runCatching { decoder.decodeString() }.getOrNull()
        }
        if (raw == null) return fallback
        return entries.firstOrNull { it.wire == raw } ?: fallback
    }

    override fun serialize(encoder: Encoder, value: T) {
        encoder.encodeString(value.wire)
    }
}

/**
 * Unix-millisecond timestamp that also accepts an ISO-8601 string. The
 * same logical chunk arrives in two dressings — WS `chunk` events relay
 * the wire shape with numeric millis, REST rows serialize `ts` as the
 * ISO string Prisma produces. Unparseable input decodes as 0, never as
 * an error, matching ArgusKit's ResultChunk decoder.
 */
object EpochMillisSerializer : KSerializer<Long> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("app.argus.core.EpochMillis", PrimitiveKind.LONG)

    override fun deserialize(decoder: Decoder): Long {
        if (decoder !is JsonDecoder) return decoder.decodeLong()
        val primitive = decoder.decodeJsonElement() as? JsonPrimitive ?: return 0
        if (primitive.isString) return ISO8601.parseMillis(primitive.content) ?: 0
        primitive.longOrNull?.let { return it }
        primitive.doubleOrNull?.let { if (it.isFinite()) return it.toLong() }
        return 0
    }

    override fun serialize(encoder: Encoder, value: Long) {
        encoder.encodeLong(value)
    }
}

/**
 * ISO-8601 parsing for the string timestamps the API carries. Prisma
 * serializes with fractional seconds (`2026-07-05T12:34:56.789Z`);
 * [Instant.parse] accepts that and the whole-second form, and the
 * offset form (`+02:00`) is covered by the fallback.
 */
object ISO8601 {
    fun parseMillis(text: String): Long? {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return null
        return try {
            Instant.parse(trimmed).toEpochMilli()
        } catch (_: DateTimeParseException) {
            try {
                OffsetDateTime.parse(trimmed).toInstant().toEpochMilli()
            } catch (_: DateTimeParseException) {
                null
            }
        }
    }
}

// MARK: Tolerant accessors (the JSONValue stand-in)

/** The string content, or null for anything that is not a JSON string. */
val JsonElement.asString: String?
    get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** A finite JSON number, or null. Strings are NOT numbers here — see [numberish]. */
val JsonElement.asDouble: Double?
    get() = (this as? JsonPrimitive)
        ?.takeIf { !it.isString }
        ?.doubleOrNull
        ?.takeIf { it.isFinite() }

/** [asDouble] truncated toward zero, mirroring Swift's `Int(double)`. */
val JsonElement.asInt: Int?
    get() = asDouble?.toInt()

val JsonElement.asLong: Long?
    get() = asDouble?.toLong()

/** A JSON boolean, or null. */
val JsonElement.asBool: Boolean?
    get() = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

val JsonElement.asObject: JsonObject?
    get() = this as? JsonObject

val JsonElement.asArray: JsonArray?
    get() = this as? JsonArray

/**
 * Number, or a numeric string — mirrors shared-types `asNumber`, which
 * tolerates adapters that serialize counters as strings.
 */
val JsonElement.numberish: Double?
    get() {
        val primitive = this as? JsonPrimitive ?: return null
        if (primitive.isString) {
            return primitive.content.toDoubleOrNull()?.takeIf { it.isFinite() }
        }
        return primitive.doubleOrNull?.takeIf { it.isFinite() }
    }

/** Keyed lookup on an object, null for any other element or a missing key. */
operator fun JsonElement.get(key: String): JsonElement? = asObject?.get(key)

/** Indexed lookup on an array, null for any other element or out of range. */
operator fun JsonElement.get(index: Int): JsonElement? = asArray?.getOrNull(index)

/**
 * First present-and-parseable number among [keys], else 0 — mirrors
 * shared-types `pickNumber`, so "adapter emits 0" and "adapter doesn't
 * emit this field" collapse the same way they do on the web.
 */
fun JsonObject.pickNumber(vararg keys: String): Double {
    for (key in keys) {
        val value = this[key]?.numberish
        if (value != null) return value
    }
    return 0.0
}
