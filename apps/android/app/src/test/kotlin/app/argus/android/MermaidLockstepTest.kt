package app.argus.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Mechanically enforces that the mermaid runtime the Android app ships
 * (`apps/ios/Argus/Resources/mermaid.min.js` — vendored ONCE and merged
 * into this app's assets by the source-set entry in app/build.gradle.kts,
 * drawn by `MermaidBlock` for ```mermaid answer blocks) is the same
 * release the web app resolves through pnpm. The web gets mermaid as a
 * dependency; the native apps can't, so their copy is a checked-in file
 * that nothing else ties to the web's version — a `pnpm up mermaid`
 * would silently leave the clients drawing the same diagram with
 * different releases.
 *
 * Port of apps/ios/ArgusKit/Tests/ArgusKitTests/MermaidLockstepTests.swift
 * (same posture as ContextWindowLockstepTest): read both sides off the
 * repo checkout, compare, and say exactly how to fix it.
 */
class MermaidLockstepTest {
    @Test
    fun vendoredBundleMatchesLockfile() {
        val root = repoRoot()

        val bundleFile = File(root, VENDORED_BUNDLE)
        assertTrue(
            "mermaid.min.js not found at ${bundleFile.path} — run scripts/sync-ios-mermaid.sh.",
            bundleFile.isFile,
        )
        val vendored = embeddedVersion(bundleFile.readText(Charsets.UTF_8))
        assertNotNull(
            "no version:\"x.y.z\" literal in the vendored mermaid.min.js — the bundle's shape changed; update embeddedVersion().",
            vendored,
        )

        val lockFile = File(root, "pnpm-lock.yaml")
        assertTrue("pnpm-lock.yaml not found at ${lockFile.path}.", lockFile.isFile)
        val resolved = webResolvedVersion(lockFile.readText(Charsets.UTF_8))
        assertNotNull(
            "pnpm-lock.yaml has no mermaid entry under the apps/web importer — did the web app drop the dependency? Then drop the vendored copy too.",
            resolved,
        )

        assertEquals(
            "Android ships mermaid $vendored (via $VENDORED_BUNDLE) but apps/web resolves $resolved. " +
                "Run scripts/sync-ios-mermaid.sh and commit the refreshed $VENDORED_BUNDLE.",
            resolved,
            vendored,
        )
    }

    @Test
    fun embeddedVersionReadsTheFirstVersionLiteral() {
        assertEquals("11.14.0", embeddedVersion("!function(){var e={version:\"11.14.0\",foo:1}}();"))
        assertNull(embeddedVersion("no literal here"))
    }

    @Test
    fun webResolvedVersionReadsTheImporterBlockOnly() {
        val lock = """
            importers:

              .:
                devDependencies:
                  mermaid:
                    specifier: ^1.0.0
                    version: 1.0.0

              apps/web:
                dependencies:
                  lucide-react:
                    specifier: ^0.469.0
                    version: 0.469.0(react@18.3.1)
                  mermaid:
                    specifier: ^11.14.0
                    version: 11.14.0(react@18.3.1)

              packages/shared-types: {}
        """.trimIndent()
        assertEquals("11.14.0", webResolvedVersion(lock))
        // The root importer's mermaid entry must not satisfy the lookup.
        assertNull(webResolvedVersion(lock.replace("\n  apps/web:", "\n  apps/other:")))
    }

    @Test
    fun webResolvedVersionStopsAtTheImporterBoundary() {
        val lock = """
            importers:

              apps/web:
                dependencies:
                  react:
                    specifier: ^18.3.1
                    version: 18.3.1

              apps/other:
                dependencies:
                  mermaid:
                    specifier: ^11.14.0
                    version: 11.14.0
        """.trimIndent()
        assertNull(webResolvedVersion(lock))
    }

    companion object {
        const val VENDORED_BUNDLE = "apps/ios/Argus/Resources/mermaid.min.js"

        /**
         * The minified bundle carries exactly one `version:"x.y.z"` literal —
         * mermaid's own package version (verified against 11.14.0; the
         * libraries it inlines don't use that shape).
         */
        fun embeddedVersion(bundle: String): String? {
            val marker = "version:\""
            val start = bundle.indexOf(marker)
            if (start < 0) return null
            val from = start + marker.length
            val close = bundle.indexOf('"', from)
            if (close < 0) return null
            return bundle.substring(from, close)
        }

        /**
         * Reads the resolved version out of the `apps/web` importer block:
         *
         *       apps/web:
         *         dependencies:
         *           mermaid:
         *             specifier: ^11.14.0
         *             version: 11.14.0
         *
         * Line-oriented on purpose — there is no YAML parser in the
         * toolchain, and this corner of the lockfile's shape is stable.
         * A peer-qualified value (`11.14.0(react@18.3.1)`) is trimmed to
         * its bare version.
         */
        fun webResolvedVersion(lock: String): String? {
            var inImporter = false
            var inMermaid = false
            for (line in lock.split("\n")) {
                if (line == "  apps/web:") {
                    inImporter = true
                    continue
                }
                if (!inImporter) continue
                // The next importer (2-space key) or top-level section ends the block.
                if (line.isNotEmpty() && !line.startsWith("    ")) return null
                if (line == "      mermaid:") {
                    inMermaid = true
                    continue
                }
                if (!inMermaid) continue
                val trimmed = line.trim()
                if (trimmed.startsWith("version: ")) {
                    return trimmed.removePrefix("version: ").substringBefore('(')
                }
                // Another package at the same depth: mermaid's entry ended without a version.
                if (line.startsWith("      ") && !line.startsWith("       ")) return null
            }
            return null
        }

        /**
         * The repository root: Gradle runs unit tests with the module
         * directory as `user.dir`, so walk up until the workspace file
         * appears (the same fallback :core's TestSupport uses).
         */
        fun repoRoot(): File {
            System.getProperty("argus.repoRoot")?.let { return File(it) }
            var dir: File? = File(System.getProperty("user.dir")).absoluteFile
            while (dir != null) {
                if (File(dir, "pnpm-workspace.yaml").isFile) return dir
                dir = dir.parentFile
            }
            error("could not locate the repository root (no pnpm-workspace.yaml above ${System.getProperty("user.dir")})")
        }
    }
}
