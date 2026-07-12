import Foundation

/// A validated Argus server base URL, parsed from whatever the user types
/// into the connect screen ("argus.example.com:4000", "http://192.168.1.5:4000",
/// "https://argus.example.com/").
public struct ServerConfig: Codable, Equatable, Sendable {
    public let baseURL: URL

    public init(baseURL: URL) {
        self.baseURL = baseURL
    }

    /// Host (+ non-default port) for display and as the Keychain account key.
    public var displayName: String {
        guard let host = baseURL.host else { return baseURL.absoluteString }
        if let port = baseURL.port { return "\(host):\(port)" }
        return host
    }

    /// Parse user input into a config.
    ///
    /// Scheme inference: explicit `http://` / `https://` is respected;
    /// otherwise loopback, RFC-1918 addresses, and `.local` hosts default
    /// to `http` (self-hosted LAN servers rarely have TLS), everything
    /// else defaults to `https`. A trailing slash is stripped so path
    /// concatenation stays uniform.
    public static func parse(_ raw: String) -> ServerConfig? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }

        if let schemeRange = text.range(of: "://") {
            let scheme = text[..<schemeRange.lowerBound].lowercased()
            guard scheme == "http" || scheme == "https" else { return nil }
        } else {
            let hostPart = String(text.split(separator: "/", maxSplits: 1).first ?? "")
            text = (isPrivateHost(hostPart) ? "http://" : "https://") + text
        }

        while text.hasSuffix("/") { text.removeLast() }

        guard
            var components = URLComponents(string: text),
            let host = components.host, !host.isEmpty
        else { return nil }
        // Anything beyond scheme://host:port/path is user error for a base URL.
        components.query = nil
        components.fragment = nil

        guard let url = components.url else { return nil }
        return ServerConfig(baseURL: url)
    }

    /// Loopback / RFC-1918 / mDNS hosts, where a cleartext default is the
    /// pragmatic choice for a self-hosted dashboard.
    static func isPrivateHost(_ hostWithPort: String) -> Bool {
        var host = hostWithPort
        // Strip a :port suffix (but not IPv6 colons — bracketed form only).
        if host.hasPrefix("[") {
            if let end = host.firstIndex(of: "]") {
                host = String(host[host.index(after: host.startIndex)..<end])
            }
        } else if let colon = host.lastIndex(of: ":"), host.filter({ $0 == ":" }).count == 1 {
            host = String(host[..<colon])
        }
        host = host.lowercased()

        if host == "localhost" || host == "::1" { return true }
        if host.hasSuffix(".local") { return true }
        if host.hasPrefix("127.") || host.hasPrefix("10.") || host.hasPrefix("192.168.") {
            return true
        }
        // 172.16.0.0/12
        if host.hasPrefix("172.") {
            let parts = host.split(separator: ".")
            if parts.count == 4, let second = Int(parts[1]), (16...31).contains(second) {
                return true
            }
        }
        return false
    }
}

/// ISO-8601 parsing for the string timestamps the API carries. Prisma
/// serializes with fractional seconds ("2026-07-05T12:34:56.789Z"), which
/// plain `ISO8601DateFormatter` rejects without the fractional option —
/// so try both.
public enum ISO8601 {
    // ISO8601DateFormatter is documented thread-safe; cache both variants
    // (REST chunk decoding calls this per row).
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let whole: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    public static func parse(_ string: String) -> Date? {
        fractional.date(from: string) ?? whole.date(from: string)
    }
}
