import Foundation

// Mirrors packages/shared-types/src/api.ts (auth section).

public struct AuthUser: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let email: String
    /// 'admin' | 'viewer' today — kept open so a new role doesn't break login.
    public let role: String

    public init(id: String, email: String, role: String) {
        self.id = id
        self.email = email
        self.role = role
    }
}

public struct LoginRequest: Encodable, Sendable {
    public let email: String
    public let password: String

    public init(email: String, password: String) {
        self.email = email
        self.password = password
    }
}

public struct LoginResponse: Decodable, Sendable {
    public let token: String
    public let user: AuthUser
}

/// `GET /auth/me` wraps the user in an envelope.
public struct MeResponse: Decodable, Sendable {
    public let user: AuthUser
}
