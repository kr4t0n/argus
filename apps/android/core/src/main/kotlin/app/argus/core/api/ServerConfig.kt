package app.argus.core.api

import java.net.URI
import java.net.URISyntaxException

/**
 * A validated Argus server base URL, parsed from whatever the user types
 * into the connect screen ("argus.example.com:4000",
 * "http://192.168.1.5:4000", "https://argus.example.com/").
 *
 * [baseUrl] is normalized: explicit scheme, no trailing slash, no query
 * or fragment. Counterpart of ArgusKit's ServerConfig.
 */
data class ServerConfig(val baseUrl: String) {
    /** Host (+ non-default port) for display and as the credential-store key. */
    val displayName: String
        get() {
            val uri = runCatching { URI(baseUrl) }.getOrNull() ?: return baseUrl
            val host = uri.host ?: return baseUrl
            return if (uri.port != -1) "$host:${uri.port}" else host
        }

    companion object {
        /**
         * Parse user input into a config.
         *
         * Scheme inference: explicit `http://` / `https://` is respected;
         * otherwise loopback, RFC-1918 addresses, and `.local` hosts default
         * to `http` (self-hosted LAN servers rarely have TLS), everything
         * else defaults to `https`. A trailing slash is stripped so path
         * concatenation stays uniform.
         */
        fun parse(raw: String): ServerConfig? {
            var text = raw.trim()
            if (text.isEmpty()) return null

            val schemeEnd = text.indexOf("://")
            if (schemeEnd >= 0) {
                val scheme = text.substring(0, schemeEnd).lowercase()
                if (scheme != "http" && scheme != "https") return null
            } else {
                val hostPart = text.split('/', limit = 2).first()
                text = (if (isPrivateHost(hostPart)) "http://" else "https://") + text
            }

            text = text.trimEnd('/')

            val uri = try {
                URI(text)
            } catch (_: URISyntaxException) {
                return null
            }
            val host = uri.host
            if (host.isNullOrEmpty()) return null

            // Anything beyond scheme://host:port/path is user error for a
            // base URL: drop query and fragment, keep the authority verbatim.
            val normalized = buildString {
                append(uri.scheme.lowercase()).append("://").append(uri.rawAuthority)
                uri.rawPath?.trimEnd('/')?.let { append(it) }
            }
            return ServerConfig(normalized)
        }

        /**
         * Loopback / RFC-1918 / mDNS hosts, where a cleartext default is the
         * pragmatic choice for a self-hosted dashboard.
         */
        internal fun isPrivateHost(hostWithPort: String): Boolean {
            var host = hostWithPort
            // Strip a :port suffix (but not IPv6 colons — bracketed form only).
            if (host.startsWith("[")) {
                val end = host.indexOf(']')
                if (end > 0) host = host.substring(1, end)
            } else if (host.count { it == ':' } == 1) {
                host = host.substringBeforeLast(':')
            }
            host = host.lowercase()

            if (host == "localhost" || host == "::1") return true
            if (host.endsWith(".local")) return true
            if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) {
                return true
            }
            // 172.16.0.0/12
            if (host.startsWith("172.")) {
                val parts = host.split('.')
                if (parts.size == 4) {
                    val second = parts[1].toIntOrNull()
                    if (second != null && second in 16..31) return true
                }
            }
            return false
        }
    }
}
