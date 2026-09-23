package app.argus.core.model

import kotlinx.serialization.Serializable

// Mirrors packages/shared-types/src/api.ts (auth section).

@Serializable
data class AuthUser(
    val id: String,
    val email: String,
    /** 'admin' | 'viewer' today — kept open so a new role doesn't break login. */
    val role: String,
)

@Serializable
data class LoginRequest(
    val email: String,
    val password: String,
)

@Serializable
data class LoginResponse(
    val token: String,
    val user: AuthUser,
)

/** `GET /auth/me` wraps the user in an envelope. */
@Serializable
data class MeResponse(val user: AuthUser)
