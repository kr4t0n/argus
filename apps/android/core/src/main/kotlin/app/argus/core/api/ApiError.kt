package app.argus.core.api

import app.argus.core.ArgusJson
import app.argus.core.model.asArray
import app.argus.core.model.asString
import app.argus.core.model.get

/**
 * A non-2xx response from the Argus server, with the Nest error message
 * when one was parseable. [status] is 0 for failures that never produced
 * an HTTP response (bad URL, transport error surfaced as an API error).
 */
class ApiError(val status: Int, message: String) : Exception(message) {
    /** The app treats 401 as "session expired → return to login". */
    val isUnauthorized: Boolean
        get() = status == 401

    override fun toString(): String = "ApiError(status=$status, message=$message)"

    companion object {
        /**
         * Nest error bodies are `{ statusCode, message, error }` where
         * `message` may be a string OR an array of validation strings.
         */
        fun from(status: Int, body: String?): ApiError {
            val fallback = "HTTP $status"
            if (body.isNullOrBlank()) return ApiError(status, fallback)
            val value = runCatching { ArgusJson.parseToJsonElement(body) }.getOrNull()
                ?: return ApiError(status, fallback)
            val message = value["message"]
            message?.asString?.takeIf { it.isNotEmpty() }?.let { return ApiError(status, it) }
            message?.asArray?.let { parts ->
                val joined = parts.mapNotNull { it.asString }.joinToString("; ")
                if (joined.isNotEmpty()) return ApiError(status, joined)
            }
            return ApiError(status, fallback)
        }
    }
}
