import Foundation

/// Loss-less Codable stand-in for TypeScript's `Record<string, unknown>`.
///
/// `ResultChunk.meta` and `Command.options` carry raw upstream CLI events
/// whose shape drifts between CLI versions — the server stores and relays
/// them verbatim, and so do we. Everything the engine reads out of `meta`
/// goes through the tolerant accessors below, so an unexpected shape
/// degrades to `nil`, never to a decode failure.
public enum JSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    // MARK: Tolerant accessors

    public var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var double: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    public var int: Int? {
        guard let value = double, value.isFinite else { return nil }
        return Int(value)
    }

    public var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var object: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    public var array: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    /// Number, or a numeric string — mirrors shared-types `asNumber`, which
    /// tolerates adapters that serialize counters as strings.
    public var numberish: Double? {
        switch self {
        case .number(let value):
            return value.isFinite ? value : nil
        case .string(let value):
            guard let parsed = Double(value), parsed.isFinite else { return nil }
            return parsed
        default:
            return nil
        }
    }

    public subscript(key: String) -> JSONValue? {
        object?[key]
    }

    public subscript(index: Int) -> JSONValue? {
        guard let array, array.indices.contains(index) else { return nil }
        return array[index]
    }
}

extension [String: JSONValue] {
    /// First present-and-parseable number among `keys`, else 0 — mirrors
    /// shared-types `pickNumber` so "adapter emits 0" and "adapter doesn't
    /// emit this field" collapse the same way they do on the web.
    public func pickNumber(_ keys: String...) -> Double {
        for key in keys {
            if let value = self[key]?.numberish { return value }
        }
        return 0
    }
}
