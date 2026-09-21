import Foundation
import Testing
@testable import ArgusKit

/// Mechanically enforces that the mermaid runtime vendored into the iOS
/// app (`apps/ios/Argus/Resources/mermaid.min.js`, drawn by
/// `MermaidBlock` for ```mermaid answer blocks) is the same release the
/// web app resolves through pnpm. The web gets mermaid as a dependency;
/// the iOS app can't, so its copy is a checked-in file that nothing else
/// ties to the web's version — a `pnpm up mermaid` would silently leave
/// the two clients drawing the same diagram with different releases.
///
/// Same posture as `ContextWindowLockstepTests`: read both sides off the
/// repo checkout, compare, and say exactly how to fix it.
@Suite("Mermaid lockstep — vendored iOS runtime matches the web's resolved version")
struct MermaidLockstepTests {
    @Test("Resources/mermaid.min.js is the mermaid version pnpm-lock.yaml resolves for apps/web")
    func vendoredBundleMatchesLockfile() throws {
        let bundleURL = Self.repoRoot.appending(path: "apps/ios/Argus/Resources/mermaid.min.js")
        let bundle = try #require(
            try? String(contentsOf: bundleURL, encoding: .utf8),
            "mermaid.min.js not found at \(bundleURL.path) — run scripts/sync-ios-mermaid.sh."
        )
        let vendored = try #require(
            Self.embeddedVersion(in: bundle),
            "no version:\"x.y.z\" literal in the vendored mermaid.min.js — the bundle's shape changed; update embeddedVersion(in:)."
        )

        let lockURL = Self.repoRoot.appending(path: "pnpm-lock.yaml")
        let lock = try #require(
            try? String(contentsOf: lockURL, encoding: .utf8),
            "pnpm-lock.yaml not found at \(lockURL.path)."
        )
        let resolved = try #require(
            Self.webResolvedVersion(inLockfile: lock),
            "pnpm-lock.yaml has no mermaid entry under the apps/web importer — did the web app drop the dependency? Then drop the vendored copy too."
        )

        #expect(
            vendored == resolved,
            """
            iOS bundles mermaid \(vendored) but apps/web resolves \(resolved). \
            Run scripts/sync-ios-mermaid.sh and commit the refreshed \
            apps/ios/Argus/Resources/mermaid.min.js.
            """
        )
    }

    /// The minified bundle carries exactly one `version:"x.y.z"` literal —
    /// mermaid's own package version (verified against 11.14.0; the
    /// libraries it inlines don't use that shape).
    static func embeddedVersion(in bundle: String) -> String? {
        guard let marker = bundle.range(of: "version:\"") else { return nil }
        let rest = bundle[marker.upperBound...]
        guard let close = rest.firstIndex(of: "\"") else { return nil }
        return String(rest[..<close])
    }

    /// Reads the resolved version out of the `apps/web` importer block:
    ///
    ///       apps/web:
    ///         dependencies:
    ///           mermaid:
    ///             specifier: ^11.14.0
    ///             version: 11.14.0
    ///
    /// Line-oriented on purpose — there is no YAML parser in the
    /// toolchain, and this corner of the lockfile's shape is stable.
    /// A peer-qualified value (`11.14.0(react@18.3.1)`) is trimmed to
    /// its bare version.
    static func webResolvedVersion(inLockfile lock: String) -> String? {
        var inImporter = false
        var inMermaid = false
        for raw in lock.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line == "  apps/web:" {
                inImporter = true
                continue
            }
            guard inImporter else { continue }
            // The next importer (2-space key) or top-level section ends the block.
            if !line.isEmpty, !line.hasPrefix("    ") { return nil }
            if line == "      mermaid:" {
                inMermaid = true
                continue
            }
            guard inMermaid else { continue }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("version: ") {
                let value = trimmed.dropFirst("version: ".count)
                return value.split(separator: "(").first.map { String($0) }
            }
            // Another package at the same depth: mermaid's entry ended without a version.
            if line.hasPrefix("      "), !line.hasPrefix("       ") { return nil }
        }
        return nil
    }

    /// This file sits at apps/ios/ArgusKit/Tests/ArgusKitTests/ —
    /// six components up is the repo root (see ContextWindowLockstepTests).
    private static var repoRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // MermaidLockstepTests.swift
            .deletingLastPathComponent() // ArgusKitTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // ArgusKit
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // apps → repo root
    }
}
