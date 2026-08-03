package machine

import (
	"testing"
)

// entryNames flattens a listing to just the names, for readable asserts.
func entryNames(entries []FSEntry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Name)
	}
	return out
}

func findEntry(entries []FSEntry, name string) *FSEntry {
	for i := range entries {
		if entries[i].Name == name {
			return &entries[i]
		}
	}
	return nil
}

// showAllTree mirrors the shape that actually broke: an ignored
// directory with enough nesting that a depth-3 prefetch would walk it.
func showAllTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		".gitignore":                  "node_modules/\n",
		"src/main.go":                 "package main",
		"src/sub/deep/file.go":        "package deep",
		"node_modules/.pnpm/pkg/a.js": "//a",
		"node_modules/react/index.js": "//r",
		"README.md":                   "x",
	})
	return root
}

// ShowAll must reveal the ignored directory WITHOUT the walk entering
// it. Before this change the matcher was left nil for ShowAll, so
// nothing was flagged ignored, so the BFS descended into node_modules —
// one .pnpm directory was enough to blow the server's 5s fs-list
// timeout and surface as "agent did not respond".
func TestListDirsShowAllListsButDoesNotDescend(t *testing.T) {
	root := showAllTree(t)

	listings, err := ListDirs(ListDirRequest{WorkingDir: root, ShowAll: true}, 3, 5000)
	if err != nil {
		t.Fatalf("ListDirs: %v", err)
	}

	rootEntries := listings[""]
	nm := findEntry(rootEntries, "node_modules")
	if nm == nil {
		t.Fatalf("ShowAll should LIST node_modules; root had %v", entryNames(rootEntries))
	}
	if !nm.Gitignored {
		t.Error("node_modules must still be flagged Gitignored so the client can dim it")
	}

	// The actual regression guard: no listing key for the ignored tree.
	for _, walked := range []string{"node_modules", "node_modules/.pnpm", "node_modules/react"} {
		if _, ok := listings[walked]; ok {
			t.Errorf("walk descended into %q — ShowAll must not prefetch an ignored subtree", walked)
		}
	}

	// Non-ignored subtrees are still walked to full depth.
	for _, want := range []string{"src", "src/sub"} {
		if _, ok := listings[want]; !ok {
			t.Errorf("expected %q to be walked; got keys %v", want, mapKeys(listings))
		}
	}
}

// With the filter on (the default), an ignored entry is dropped from the
// listing entirely — unchanged by this commit, and worth pinning so the
// two modes can't collapse into each other.
func TestListDirsDefaultHidesIgnored(t *testing.T) {
	root := showAllTree(t)

	listings, err := ListDirs(ListDirRequest{WorkingDir: root, ShowAll: false}, 3, 5000)
	if err != nil {
		t.Fatalf("ListDirs: %v", err)
	}
	if findEntry(listings[""], "node_modules") != nil {
		t.Errorf("filter ON should omit node_modules; got %v", entryNames(listings[""]))
	}
	if _, ok := listings["node_modules"]; ok {
		t.Error("filter ON must not walk node_modules either")
	}
}

// An ignored subtree stays reachable by asking for it directly: the
// descent guard only gates enqueueing CHILDREN, so the requested path is
// always listed. This is what keeps the toggle usable rather than
// merely safe — you can still walk in, one deliberate level at a time.
func TestListDirsIgnoredPathReachableByRequest(t *testing.T) {
	root := showAllTree(t)

	listings, err := ListDirs(
		ListDirRequest{WorkingDir: root, Path: "node_modules", ShowAll: true}, 3, 5000)
	if err != nil {
		t.Fatalf("ListDirs on an ignored path: %v", err)
	}

	entries := listings["node_modules"]
	if findEntry(entries, ".pnpm") == nil || findEntry(entries, "react") == nil {
		t.Fatalf("requesting node_modules directly should list its children; got %v",
			entryNames(entries))
	}
	// Children of an ignored dir are ignored too, so a depth-3 request
	// self-limits to one level instead of walking the whole tree.
	if _, ok := listings["node_modules/.pnpm"]; ok {
		t.Error("depth-3 inside an ignored tree should still stop at one level")
	}
}

func mapKeys(m map[string][]FSEntry) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
