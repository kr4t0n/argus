import Foundation
import Security

/// Keychain persistence for the login JWT, keyed by server (so multiple
/// self-hosted servers can coexist).
///
/// Usage contract: read ONCE at app launch into memory and hand
/// `ArgusClient` an in-memory token provider — do NOT wire
/// `TokenStore.read` in as the per-request provider (per-request Keychain
/// reads were a real perf bug in the previous client attempt).
public enum TokenStore {
    private static let service = "app.argus.jwt"

    private static func baseQuery(server: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: server,
        ]
    }

    @discardableResult
    public static func save(_ token: String, server: String) -> Bool {
        guard let data = token.data(using: .utf8) else { return false }
        // Delete-then-add: simpler than juggling SecItemUpdate's add/update
        // split, and this is a rare operation (login / logout only).
        SecItemDelete(baseQuery(server: server) as CFDictionary)
        var attributes = baseQuery(server: server)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
    }

    public static func read(server: String) -> String? {
        var query = baseQuery(server: server)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    public static func clear(server: String) -> Bool {
        SecItemDelete(baseQuery(server: server) as CFDictionary) == errSecSuccess
    }
}
