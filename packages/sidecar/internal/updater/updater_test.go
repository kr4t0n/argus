package updater

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

// TestCompareVersion locks in the SemVer 2.0.0 precedence rules
// pickLatestRelease relies on. The "0.1.11 vs 0.1.12-rc.1" case is the
// regression that broke `argus-sidecar update --prerelease` — GitHub's
// API returned 0.1.11 first in the listing, and the previous logic
// returned the first matching release without comparing versions.
func TestCompareVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		// Regression case: a higher patch with a prerelease still beats
		// a lower stable patch.
		{"0.1.12-rc.1", "0.1.11", 1},
		{"0.1.11", "0.1.12-rc.1", -1},

		// Equal versions.
		{"1.2.3", "1.2.3", 0},
		{"1.2.3-rc.1", "1.2.3-rc.1", 0},

		// Stable > prerelease at same MAJOR.MINOR.PATCH.
		{"1.2.3", "1.2.3-rc.1", 1},
		{"1.2.3-rc.1", "1.2.3", -1},

		// Numeric prerelease ordering.
		{"1.0.0-rc.1", "1.0.0-rc.2", -1},
		{"1.0.0-rc.10", "1.0.0-rc.2", 1},

		// Main version dominates prerelease.
		{"2.0.0-rc.1", "1.99.99", 1},

		// SemVer §11.4: numeric IDs sort below alphanumeric.
		{"1.0.0-1", "1.0.0-alpha", -1},
		// Shorter prerelease list sorts below longer when prefix matches.
		{"1.0.0-alpha", "1.0.0-alpha.1", -1},
	}
	for _, tc := range cases {
		got := compareVersion(tc.a, tc.b)
		if got != tc.want {
			t.Errorf("compareVersion(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestIsValidVersion(t *testing.T) {
	valid := []string{"0.1.11", "0.1.12-rc.1", "10.20.30", "1.0.0-alpha.beta.1"}
	for _, v := range valid {
		if !isValidVersion(v) {
			t.Errorf("isValidVersion(%q) = false, want true", v)
		}
	}
	invalid := []string{"", "0.1", "0.1.x", "0.1.0-", "0.1.0-rc..1", "0.1.0+build.1"}
	for _, v := range invalid {
		if isValidVersion(v) {
			t.Errorf("isValidVersion(%q) = true, want false", v)
		}
	}
}

// TestRankSidecarTags pins the feed resolver's filtering and ordering.
// The feed hands us tags in publish order and mixes in other components'
// releases plus bare tags, so this is the function that has to be strict.
func TestRankSidecarTags(t *testing.T) {
	feed := []string{
		"v0.3.4",                    // another component — not ours
		"argus-sidecar-v0.3.4-rc.2", // prerelease, by tag suffix
		"argus-sidecar-v0.3.3",      // newest stable
		"argus-sidecar-v0.3.4-rc.1", // older prerelease
		"argus-sidecar-v0.3.2",      //
		"argus-sidecar-vbanana",     // prefixed but unparseable
		"argus-sidecar-v0.3.3",      // duplicate entry
		"argus-web-v1.0.0",          // future component
	}

	stable := rankSidecarTags(feed, false)
	wantStable := []string{"argus-sidecar-v0.3.3", "argus-sidecar-v0.3.2"}
	if len(stable) != len(wantStable) {
		t.Fatalf("stable = %v, want %v", stable, wantStable)
	}
	for i := range wantStable {
		if stable[i] != wantStable[i] {
			t.Errorf("stable[%d] = %q, want %q", i, stable[i], wantStable[i])
		}
	}

	// With prereleases enabled the rc line sorts above the stable it
	// precedes, and rc.2 above rc.1 — publish order in the feed would
	// have given the reverse.
	pre := rankSidecarTags(feed, true)
	want := []string{
		"argus-sidecar-v0.3.4-rc.2",
		"argus-sidecar-v0.3.4-rc.1",
		"argus-sidecar-v0.3.3",
		"argus-sidecar-v0.3.2",
	}
	if len(pre) != len(want) {
		t.Fatalf("prerelease = %v, want %v", pre, want)
	}
	for i := range want {
		if pre[i] != want[i] {
			t.Errorf("prerelease[%d] = %q, want %q", i, pre[i], want[i])
		}
	}
}

// atomFixture renders a feed in the shape github.com/<repo>/releases.atom
// actually serves: entries carry no prerelease flag, and bare tags appear
// alongside published releases.
func atomFixture(base, repo string, tags []string) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<feed xmlns="http://www.w3.org/2005/Atom">` + "\n")
	for _, tag := range tags {
		fmt.Fprintf(&b, "  <entry>\n    <id>tag:github.com,2008:Repository/1/%s</id>\n", tag)
		fmt.Fprintf(&b, "    <link rel=\"alternate\" type=\"text/html\" href=\"%s/%s/releases/tag/%s\"/>\n", base, repo, tag)
		fmt.Fprintf(&b, "    <title>%s</title>\n  </entry>\n", tag)
	}
	b.WriteString("</feed>\n")
	return b.String()
}

// TestPickLatestReleaseFeed covers the default resolution path end to end:
// read the feed, rank the tags, probe the newest for published assets, and
// hand back a release whose asset URLs point at the download redirect. The
// recorded request paths double as the assertion that we never reach for
// api.github.com — the reason this path exists at all.
func TestPickLatestReleaseFeed(t *testing.T) {
	const repo = "kr4t0n/argus"
	var mu sync.Mutex
	var hits []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits = append(hits, r.Method+" "+r.URL.Path)
		mu.Unlock()

		switch r.URL.Path {
		case "/" + repo + "/releases.atom":
			_, _ = w.Write([]byte(atomFixture("http://example.invalid", repo, []string{
				"v0.4.0",
				"argus-sidecar-v0.3.4", // newest, but still building — no assets
				"argus-sidecar-v0.3.3",
			})))
		case "/" + repo + "/releases/download/argus-sidecar-v0.3.3/SHASUMS256.txt":
			_, _ = w.Write([]byte("deadbeef  argus-sidecar-linux-amd64\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	prev := githubWebBase
	githubWebBase = srv.URL
	defer func() { githubWebBase = prev }()

	logger := log.New(io.Discard, "", 0)
	rel, err := pickLatestReleaseFeed(context.Background(), srv.Client(), logger, repo, false)
	if err != nil {
		t.Fatalf("pickLatestReleaseFeed: %v", err)
	}

	// v0.3.4 outranks v0.3.3 but its assets 404, so the resolver must
	// fall through rather than return a release nobody can download.
	if rel.TagName != "argus-sidecar-v0.3.3" {
		t.Errorf("TagName = %q, want argus-sidecar-v0.3.3", rel.TagName)
	}

	// The feed carries no asset listing, so lookups synthesize a URL
	// under the release's download prefix.
	got := rel.findAsset("argus-sidecar-linux-amd64")
	if got == nil {
		t.Fatal("findAsset returned nil for a feed-resolved release")
	}
	want := srv.URL + "/" + repo + "/releases/download/argus-sidecar-v0.3.3/argus-sidecar-linux-amd64"
	if got.downloadURL() != want {
		t.Errorf("downloadURL = %q, want %q", got.downloadURL(), want)
	}

	mu.Lock()
	defer mu.Unlock()
	for _, h := range hits {
		if strings.Contains(h, "/api/") || strings.Contains(h, "/repos/") {
			t.Errorf("feed resolver hit an API-shaped path: %s", h)
		}
	}
	if len(hits) != 3 {
		t.Errorf("hits = %v, want feed + two HEAD probes", hits)
	}
}

// TestPickLatestReleaseFeedNoMatch confirms a feed with no sidecar tags is
// an error rather than a silent nil — the caller falls back to the REST
// API on that error, which is the documented behaviour when a burst of
// other releases pushes every sidecar tag out of the ten-entry window.
func TestPickLatestReleaseFeedNoMatch(t *testing.T) {
	const repo = "kr4t0n/argus"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(atomFixture("http://example.invalid", repo, []string{"v0.4.0", "v0.3.9"})))
	}))
	defer srv.Close()

	prev := githubWebBase
	githubWebBase = srv.URL
	defer func() { githubWebBase = prev }()

	_, err := pickLatestReleaseFeed(context.Background(), srv.Client(), log.New(io.Discard, "", 0), repo, false)
	if err == nil || !strings.Contains(err.Error(), "no matching sidecar release") {
		t.Fatalf("err = %v, want no-matching-release error", err)
	}
}

// fakeRelease spins up an httptest server serving a single binary asset plus
// a SHASUMS256.txt, and returns a *release pointing at them. assetBase names
// the binary asset (`<assetBase>-<goos>-<goarch>`). sums overrides the
// checksum file body so the mismatch path can be tested; pass "" to serve
// the correct checksum.
func fakeRelease(t *testing.T, assetBase string, payload []byte, sums string) (*release, *http.Client, func()) {
	t.Helper()
	binName := fmt.Sprintf("%s-%s-%s", assetBase, runtime.GOOS, runtime.GOARCH)
	if sums == "" {
		sum := sha256.Sum256(payload)
		sums = fmt.Sprintf("%s  %s\n", hex.EncodeToString(sum[:]), binName)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bin":
			_, _ = w.Write(payload)
		case "/sums":
			_, _ = w.Write([]byte(sums))
		default:
			http.NotFound(w, r)
		}
	}))
	rel := &release{
		TagName: "argus-sidecar-v1.2.3",
		Assets: []asset{
			{Name: binName, URL: srv.URL + "/bin", Size: int64(len(payload))},
			{Name: "SHASUMS256.txt", URL: srv.URL + "/sums"},
		},
	}
	return rel, srv.Client(), srv.Close
}

// TestInstallFromRelease exercises the full download → checksum-verify →
// chmod → atomic-install primitive that backs Update. The destination need
// not pre-exist, so we install into a fresh temp path.
func TestInstallFromRelease(t *testing.T) {
	payload := []byte("#!/bin/sh\necho fake argus-sidecar\n")
	rel, client, closeSrv := fakeRelease(t, "argus-sidecar", payload, "")
	defer closeSrv()

	dest := filepath.Join(t.TempDir(), "argus-sidecar")
	logger := log.New(io.Discard, "", 0)
	if err := installFromRelease(context.Background(), client, logger, rel, "argus-sidecar", dest); err != nil {
		t.Fatalf("installFromRelease: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read installed binary: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("installed bytes = %q, want %q", got, payload)
	}
	fi, err := os.Stat(dest)
	if err != nil {
		t.Fatalf("stat installed binary: %v", err)
	}
	if fi.Mode().Perm() != 0o755 {
		t.Errorf("installed mode = %v, want 0755", fi.Mode().Perm())
	}
}

// TestInstallFromReleaseChecksumMismatch verifies we refuse to install (and
// leave nothing behind) when the downloaded bytes don't match SHASUMS256.txt.
func TestInstallFromReleaseChecksumMismatch(t *testing.T) {
	payload := []byte("real payload")
	binName := fmt.Sprintf("argus-sidecar-%s-%s", runtime.GOOS, runtime.GOARCH)
	// A syntactically valid but wrong checksum line.
	wrongSums := fmt.Sprintf("%064x  %s\n", 0, binName)
	rel, client, closeSrv := fakeRelease(t, "argus-sidecar", payload, wrongSums)
	defer closeSrv()

	dest := filepath.Join(t.TempDir(), "argus-sidecar")
	logger := log.New(io.Discard, "", 0)
	err := installFromRelease(context.Background(), client, logger, rel, "argus-sidecar", dest)
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("err = %v, want checksum mismatch", err)
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Errorf("destination should not exist after a failed install, stat err = %v", statErr)
	}
}

// TestInstallFromReleaseMissingAsset covers a release that lacks the binary
// for this OS/arch (e.g. a release built for fewer platforms): we surface a
// clear error rather than panicking or installing garbage.
func TestInstallFromReleaseMissingAsset(t *testing.T) {
	rel := &release{TagName: "argus-sidecar-v1.2.3", Assets: nil}
	logger := log.New(io.Discard, "", 0)
	err := installFromRelease(context.Background(), &http.Client{}, logger, rel, "argus-sidecar", filepath.Join(t.TempDir(), "argus-sidecar"))
	if err == nil || !strings.Contains(err.Error(), "no asset named") {
		t.Fatalf("err = %v, want missing-asset error", err)
	}
}

// TestRemoveLegacyCompanion covers the post-swap sweep of the retired
// argus-bg sibling: an installed copy is deleted, and a missing one is the
// quiet no-op fresh installs hit every time.
func TestRemoveLegacyCompanion(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "argus-bg")
	if err := os.WriteFile(legacy, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("seed legacy companion: %v", err)
	}
	logger := log.New(io.Discard, "", 0)

	removeLegacyCompanion(logger, dir)
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy companion still present after sweep, stat err = %v", err)
	}

	// Second pass: nothing to remove, must not panic or log an error path.
	removeLegacyCompanion(logger, dir)
}
