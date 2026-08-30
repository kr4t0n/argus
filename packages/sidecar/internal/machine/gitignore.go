package machine

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"sync"

	gitignore "github.com/go-git/go-git/v5/plumbing/format/gitignore"
)

// ignoreIndex answers "would git ignore this path?" for a tree rooted at
// `root`, honoring a .gitignore in EVERY directory rather than only the
// one at the root.
//
// Why not the library's own ReadPatterns: it recurses the whole tree
// eagerly, descending into node_modules and every other heavy directory
// just to look for .gitignore files. The file lister builds an index per
// request, so that would put a full-tree walk in front of every click.
// Here each directory's patterns are read at most once, on demand, and a
// subtree nobody asks about is never touched.
//
// Patterns are scoped by "domain" (the path components of the directory
// the file was found in), which is what makes nested files behave like
// git: a rule in apps/ios/.gitignore constrains apps/ios/** and nothing
// else, and later (deeper) patterns win over earlier ones — including
// re-inclusions via `!`.
//
// Safe for concurrent use: the watcher matches from its event goroutine
// while a list request may be walking the same tree.
type ignoreIndex struct {
	root string

	mu sync.Mutex
	// Accumulated root→dir patterns, keyed by slash-separated dir path
	// relative to root ("" = root). Memoized: a child extends its
	// parent's slice rather than re-reading every ancestor.
	byDir map[string][]gitignore.Pattern
}

// newIgnoreIndex builds an empty index for `root`. Nothing is read from
// disk until the first Match — constructing one is free.
func newIgnoreIndex(root string) *ignoreIndex {
	abs, err := filepath.Abs(root)
	if err != nil {
		abs = root
	}
	return &ignoreIndex{
		root:  filepath.Clean(abs),
		byDir: make(map[string][]gitignore.Pattern),
	}
}

// Match reports whether `rel` — a path relative to root, in either OS or
// slash form — is ignored. `isDir` matters: a `build/` rule matches the
// directory but not a file of the same name.
//
// A nil index matches nothing, so callers can keep "filtering disabled"
// as a nil check.
func (ix *ignoreIndex) Match(rel string, isDir bool) bool {
	if ix == nil {
		return false
	}
	parts := splitRel(rel)
	if len(parts) == 0 {
		return false
	}
	// A directory's OWN .gitignore has no say over the directory itself,
	// so match against the patterns visible to its parent.
	patterns := ix.patternsFor(parts[:len(parts)-1])
	if len(patterns) == 0 {
		return false
	}
	return gitignore.NewMatcher(patterns).Match(parts, isDir)
}

// patternsFor returns every pattern in scope for directory `dir` (given
// as path components relative to root), reading .gitignore files along
// the way. Ancestors are resolved first so each level's slice is built
// once and reused by all its descendants.
func (ix *ignoreIndex) patternsFor(dir []string) []gitignore.Pattern {
	key := strings.Join(dir, "/")

	ix.mu.Lock()
	cached, ok := ix.byDir[key]
	ix.mu.Unlock()
	if ok {
		return cached
	}

	var parent []gitignore.Pattern
	if len(dir) > 0 {
		parent = ix.patternsFor(dir[:len(dir)-1])
	}

	own := readIgnoreFile(filepath.Join(append([]string{ix.root}, dir...)...), dir)

	// Copy rather than append-in-place: appending to the parent's slice
	// could write into spare capacity shared with a sibling directory,
	// leaking one subtree's rules into another.
	combined := make([]gitignore.Pattern, 0, len(parent)+len(own))
	combined = append(combined, parent...)
	combined = append(combined, own...)

	ix.mu.Lock()
	ix.byDir[key] = combined
	ix.mu.Unlock()
	return combined
}

// readIgnoreFile parses <dir>/.gitignore, tagging every pattern with
// `domain` so it only applies at or below that directory. A missing file
// is normal and yields no patterns.
func readIgnoreFile(dirAbs string, domain []string) []gitignore.Pattern {
	f, err := os.Open(filepath.Join(dirAbs, ".gitignore"))
	if err != nil {
		return nil
	}
	defer f.Close()

	var ps []gitignore.Pattern
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		// Same filter git applies: comments and blank lines carry no rule.
		if strings.HasPrefix(line, "#") || strings.TrimSpace(line) == "" {
			continue
		}
		ps = append(ps, gitignore.ParsePattern(line, domain))
	}
	return ps
}

// splitRel normalizes a relative path to the component slice the matcher
// wants, tolerating OS separators, "./" prefixes and trailing slashes.
func splitRel(rel string) []string {
	rel = filepath.ToSlash(rel)
	rel = strings.Trim(rel, "/")
	if rel == "" || rel == "." {
		return nil
	}
	parts := strings.Split(rel, "/")
	out := parts[:0]
	for _, p := range parts {
		if p != "" && p != "." {
			out = append(out, p)
		}
	}
	return out
}
