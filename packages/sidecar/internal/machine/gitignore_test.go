package machine

import (
	"os"
	"path/filepath"
	"testing"
)

// writeTree materializes a map of relative path → contents. A path
// ending in "/" is created as an empty directory.
func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, body := range files {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if body == "" && filepath.Ext(rel) == "" && rel[len(rel)-1] == '/' {
			if err := os.MkdirAll(abs, 0o755); err != nil {
				t.Fatalf("mkdir %s: %v", rel, err)
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatalf("mkdir parent of %s: %v", rel, err)
		}
		if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
}

// The regression this whole file exists for: a .gitignore in a
// subdirectory used to be invisible, so iOS build output (apps/ios has
// its own ignore file in this repo) was listed in the tree AND handed an
// fsnotify watch per directory.
func TestIgnoreIndexHonorsNestedGitignore(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		".gitignore":            "node_modules/\ndist/\n",
		"apps/ios/.gitignore":   ".build/\nDerivedData/\nxcuserdata/\n",
		"site/.gitignore":       ".astro/\n",
		"apps/ios/Sources/a.sw": "x",
		"README.md":             "x",
	})

	ix := newIgnoreIndex(root)

	cases := []struct {
		path  string
		isDir bool
		want  bool
		why   string
	}{
		// Root rules still apply, at the root and at any depth.
		{"node_modules", true, true, "root rule at root"},
		{"apps/web/node_modules", true, true, "root rule matches at depth"},
		{"dist", true, true, "root rule"},
		{"README.md", false, false, "ordinary file"},

		// The nested rules — every one of these was false before.
		{"apps/ios/.build", true, true, "nested rule"},
		{"apps/ios/DerivedData", true, true, "nested rule"},
		{"apps/ios/xcuserdata", true, true, "nested rule"},
		{"site/.astro", true, true, "nested rule"},

		// Nested rules must NOT leak outside their own directory.
		{".build", true, false, "apps/ios rule must not apply at root"},
		{"site/.build", true, false, "apps/ios rule must not apply to site"},
		{"apps/web/DerivedData", true, false, "apps/ios rule must not apply to apps/web"},
		{".astro", true, false, "site rule must not apply at root"},

		// A directory's own .gitignore says nothing about itself.
		{"apps/ios", true, false, "the scoping directory itself"},
	}

	for _, c := range cases {
		if got := ix.Match(c.path, c.isDir); got != c.want {
			t.Errorf("Match(%q, isDir=%v) = %v, want %v — %s", c.path, c.isDir, got, c.want, c.why)
		}
	}
}

// Dir-only rules (`build/`) must not swallow a FILE of the same name.
// The old code appended a trailing slash for directories, which made
// this distinction impossible to express.
func TestIgnoreIndexDirOnlyRules(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{".gitignore": "build/\nnotes\n"})
	ix := newIgnoreIndex(root)

	if !ix.Match("build", true) {
		t.Error(`"build/" should ignore the build DIRECTORY`)
	}
	if ix.Match("build", false) {
		t.Error(`"build/" must NOT ignore a FILE named build`)
	}
	// A rule without a trailing slash binds to both.
	if !ix.Match("notes", false) || !ix.Match("notes", true) {
		t.Error(`"notes" should ignore both a file and a directory`)
	}
}

// Real git anchors a pattern containing a slash to the directory its
// .gitignore lives in. The previous library anchored only patterns with
// a LEADING slash, so `docs/build` also swallowed `pkg/docs/build`.
func TestIgnoreIndexAnchorsSlashedPatterns(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{".gitignore": "docs/build/\n/only-root/\nanywhere/\n"})
	ix := newIgnoreIndex(root)

	if !ix.Match("docs/build", true) {
		t.Error("docs/build should be ignored at the root")
	}
	if ix.Match("pkg/docs/build", true) {
		t.Error("a slashed pattern must stay anchored — pkg/docs/build is a different directory")
	}
	if !ix.Match("only-root", true) {
		t.Error("/only-root should be ignored at the root")
	}
	if ix.Match("sub/only-root", true) {
		t.Error("a leading slash anchors to the root")
	}
	// No slash at all: matches at every level, which is the git rule the
	// root .gitignore's `node_modules/` depends on.
	if !ix.Match("a/b/anywhere", true) {
		t.Error("an unslashed pattern should match at any depth")
	}
}

// `!` re-inclusion, and the precedence rule that a deeper file overrides
// a shallower one.
func TestIgnoreIndexNegationAndPrecedence(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		".gitignore":      "*.log\n",
		"keep/.gitignore": "!important.log\n",
	})
	ix := newIgnoreIndex(root)

	if !ix.Match("debug.log", false) {
		t.Error("*.log should be ignored at the root")
	}
	if !ix.Match("keep/other.log", false) {
		t.Error("the root rule still reaches into keep/")
	}
	if ix.Match("keep/important.log", false) {
		t.Error("a nested ! rule must re-include the file")
	}
}

// The index is consulted from the watcher's event goroutine while a
// list request may be walking the same tree.
func TestIgnoreIndexConcurrentMatch(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		".gitignore":   "node_modules/\n",
		"a/.gitignore": "a-only/\n",
		"b/.gitignore": "b-only/\n",
	})
	ix := newIgnoreIndex(root)

	done := make(chan bool, 4)
	check := func(path string, want bool) {
		go func() {
			ok := true
			for i := 0; i < 200; i++ {
				if ix.Match(path, true) != want {
					ok = false
					break
				}
			}
			done <- ok
		}()
	}
	// a/ and b/ rules must never bleed into each other, even when their
	// pattern slices are built concurrently.
	check("a/a-only", true)
	check("b/b-only", true)
	check("a/b-only", false)
	check("b/a-only", false)

	for i := 0; i < 4; i++ {
		if !<-done {
			t.Fatal("concurrent Match returned an inconsistent verdict")
		}
	}
}
