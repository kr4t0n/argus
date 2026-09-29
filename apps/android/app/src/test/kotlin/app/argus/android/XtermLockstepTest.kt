package app.argus.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Mechanically enforces that the xterm.js runtime the Android terminal
 * pane ships (`app/src/main/assets/xterm/`, vendored by
 * scripts/sync-android-xterm.sh) is the release the web app resolves
 * through pnpm — the same posture as [MermaidLockstepTest]. Unlike
 * mermaid, the minified xterm bundle carries no version literal, so the
 * sync script stamps the package version into `xterm/VERSION` and that
 * stamp is the pin. It is weaker (a hand edit could lie), which is why
 * the test also checks the three runtime files are present: the honest
 * way to move the stamp is to re-run the script.
 */
class XtermLockstepTest {
    @Test
    fun vendoredRuntimeMatchesLockfile() {
        val root = MermaidLockstepTest.repoRoot()
        val dir = File(root, VENDORED_DIR)
        for (name in listOf("xterm.js", "xterm.css", "addon-fit.js", "VERSION")) {
            assertTrue("$name missing under $VENDORED_DIR — run scripts/sync-android-xterm.sh.", File(dir, name).isFile)
        }
        val vendored = File(dir, "VERSION").readText(Charsets.UTF_8).trim()
        assertTrue("VERSION stamp is not a bare semver: '$vendored'", Regex("""\d+\.\d+\.\d+""").matches(vendored))

        val lockFile = File(root, "pnpm-lock.yaml")
        assertTrue("pnpm-lock.yaml not found at ${lockFile.path}.", lockFile.isFile)
        val resolved = webResolvedVersion(lockFile.readText(Charsets.UTF_8), "@xterm/xterm")
        assertNotNull(
            "pnpm-lock.yaml has no @xterm/xterm entry under the apps/web importer — did the web app drop the dependency? Then drop the vendored copy too.",
            resolved,
        )
        assertEquals(
            "Android ships xterm $vendored (via $VENDORED_DIR/VERSION) but apps/web resolves $resolved. " +
                "Run scripts/sync-android-xterm.sh and commit the refreshed $VENDORED_DIR.",
            resolved,
            vendored,
        )
    }

    @Test
    fun webResolvedVersionReadsAScopedPackageInTheImporterBlock() {
        val lock = """
            importers:

              apps/web:
                dependencies:
                  '@xterm/addon-fit':
                    specifier: ^0.11.0
                    version: 0.11.0(@xterm/xterm@6.0.0)
                  '@xterm/xterm':
                    specifier: ^6.0.0
                    version: 6.0.0
                  react:
                    specifier: ^18.3.1
                    version: 18.3.1

              packages/shared-types: {}
        """.trimIndent()
        assertEquals("6.0.0", webResolvedVersion(lock, "@xterm/xterm"))
        assertEquals("0.11.0", webResolvedVersion(lock, "@xterm/addon-fit"))
        assertNull(webResolvedVersion(lock, "@xterm/addon-web-links"))
        assertNull(webResolvedVersion(lock.replace("\n  apps/web:", "\n  apps/other:"), "@xterm/xterm"))
    }

    companion object {
        const val VENDORED_DIR = "apps/android/app/src/main/assets/xterm"

        /**
         * The resolved version of [pkg] in the `apps/web` importer block —
         * the generalised form of [MermaidLockstepTest.webResolvedVersion]
         * (scoped names are quoted in the lockfile). Line-oriented on
         * purpose: no YAML parser in the toolchain, and this corner of the
         * lockfile's shape is stable. A peer-qualified value
         * (`0.11.0(@xterm/xterm@6.0.0)`) is trimmed to its bare version.
         */
        fun webResolvedVersion(lock: String, pkg: String): String? {
            val key = if (pkg.startsWith("@")) "      '$pkg':" else "      $pkg:"
            var inImporter = false
            var inPackage = false
            for (line in lock.split("\n")) {
                if (line == "  apps/web:") {
                    inImporter = true
                    continue
                }
                if (!inImporter) continue
                if (line.isNotEmpty() && !line.startsWith("    ")) return null
                if (line == key) {
                    inPackage = true
                    continue
                }
                if (!inPackage) continue
                val trimmed = line.trim()
                if (trimmed.startsWith("version: ")) {
                    return trimmed.removePrefix("version: ").substringBefore('(')
                }
                if (line.startsWith("      ") && !line.startsWith("       ")) return null
            }
            return null
        }
    }
}
