import Foundation
import Testing
@testable import ArgusKit

@Suite("ServerConfig — user-input URL parsing")
struct ServerConfigTests {
    @Test("explicit schemes are respected")
    func explicitSchemes() throws {
        #expect(
            try #require(ServerConfig.parse("http://localhost:4000")).baseURL.absoluteString
                == "http://localhost:4000"
        )
        #expect(
            try #require(ServerConfig.parse("https://argus.example.com")).baseURL.absoluteString
                == "https://argus.example.com"
        )
    }

    @Test("private hosts default to http, public hosts to https")
    func schemeInference() throws {
        #expect(try #require(ServerConfig.parse("localhost:4000")).baseURL.scheme == "http")
        #expect(try #require(ServerConfig.parse("192.168.1.20:4000")).baseURL.scheme == "http")
        #expect(try #require(ServerConfig.parse("10.0.0.5:4000")).baseURL.scheme == "http")
        #expect(try #require(ServerConfig.parse("172.20.1.2:4000")).baseURL.scheme == "http")
        #expect(try #require(ServerConfig.parse("kyle-mbp.local:4000")).baseURL.scheme == "http")
        #expect(try #require(ServerConfig.parse("argus.example.com:4000")).baseURL.scheme == "https")
        // 172.x outside the /12 private block is public.
        #expect(try #require(ServerConfig.parse("172.10.1.2")).baseURL.scheme == "https")
    }

    @Test("trailing slashes are stripped; ports survive")
    func normalization() throws {
        let config = try #require(ServerConfig.parse("https://argus.example.com:4000/"))
        #expect(config.baseURL.absoluteString == "https://argus.example.com:4000")
        #expect(config.displayName == "argus.example.com:4000")
    }

    @Test("garbage is rejected")
    func rejectsGarbage() {
        #expect(ServerConfig.parse("") == nil)
        #expect(ServerConfig.parse("   ") == nil)
        #expect(ServerConfig.parse("ftp://argus.example.com") == nil)
    }

    @Test("ISO8601 parses both fractional and whole-second forms")
    func isoParsing() {
        #expect(ISO8601.parse("2026-07-05T10:00:00.123Z") != nil)
        #expect(ISO8601.parse("2026-07-05T10:00:00Z") != nil)
        #expect(ISO8601.parse("not a date") == nil)
    }
}
