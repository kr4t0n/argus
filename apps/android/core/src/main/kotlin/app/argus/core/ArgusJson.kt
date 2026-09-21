package app.argus.core

import kotlinx.serialization.json.Json

/**
 * The one [Json] instance every wire model decodes through.
 *
 * Decode-tolerant by decision (docs/plan-android-native-client.md §2), the
 * same posture as ArgusKit's Codable mirrors:
 *
 * - `ignoreUnknownKeys` — the server ships fields shared-types omits (a
 *   denormalized `usage` on command rows, `sessionId`/`isFinal` on WS-relayed
 *   chunks), and a newer server may add more. An unknown field is never a
 *   decode failure.
 * - `coerceInputValues` — an unrecognised enum value decodes to the
 *   property's default instead of failing the payload, so every open string
 *   enum on the wire is modelled with an `UNKNOWN` default member.
 * - `explicitNulls = false` — a nullable field that is absent decodes as
 *   `null`, and `null` fields are omitted when encoding.
 * - `encodeDefaults` is left at the library default (`false`): a property
 *   equal to its declared default is omitted when encoding, so request
 *   bodies stay minimal. Give a field no default if the server must always
 *   see it.
 *
 * Never add strictness here that rejects an unknown field.
 */
val ArgusJson: Json = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
    explicitNulls = false
}
