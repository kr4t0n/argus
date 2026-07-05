import Foundation

/// A non-2xx response from the Argus server, with the Nest error message
/// when one was parseable.
public struct APIError: Error, Equatable, Sendable, LocalizedError {
    public let status: Int
    public let message: String

    public init(status: Int, message: String) {
        self.status = status
        self.message = message
    }

    /// The app treats 401 as "session expired → return to login".
    public var isUnauthorized: Bool { status == 401 }

    public var errorDescription: String? {
        message.isEmpty ? "HTTP \(status)" : message
    }

    /// Nest error bodies are `{ statusCode, message, error }` where
    /// `message` may be a string OR an array of validation strings.
    static func from(status: Int, body: Data?) -> APIError {
        guard let body, !body.isEmpty,
              let value = try? JSONDecoder().decode(JSONValue.self, from: body)
        else {
            return APIError(status: status, message: HTTPURLResponse.localizedString(forStatusCode: status))
        }
        let message = value["message"]
        if let text = message?.string, !text.isEmpty {
            return APIError(status: status, message: text)
        }
        if let parts = message?.array {
            let joined = parts.compactMap(\.string).joined(separator: "; ")
            if !joined.isEmpty { return APIError(status: status, message: joined) }
        }
        return APIError(status: status, message: HTTPURLResponse.localizedString(forStatusCode: status))
    }
}
