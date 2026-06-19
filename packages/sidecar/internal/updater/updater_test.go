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

// fakeRelease spins up an httptest server serving a single binary asset plus
// a SHASUMS256.txt, and returns a *release pointing at them. assetBase lets
// each test name the binary asset for whatever component it's exercising
// (argus-sidecar / argus-bg). sums overrides the checksum file body so the
// mismatch path can be tested; pass "" to serve the correct checksum.
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
// chmod → atomic-install primitive that backs both Update and
// DownloadCompanion. The destination need not pre-exist (the argus-bg case),
// so we install into a fresh temp path.
func TestInstallFromRelease(t *testing.T) {
	payload := []byte("#!/bin/sh\necho fake argus-bg\n")
	rel, client, closeSrv := fakeRelease(t, "argus-bg", payload, "")
	defer closeSrv()

	dest := filepath.Join(t.TempDir(), "argus-bg")
	logger := log.New(io.Discard, "", 0)
	if err := installFromRelease(context.Background(), client, logger, rel, "argus-bg", dest); err != nil {
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
	binName := fmt.Sprintf("argus-bg-%s-%s", runtime.GOOS, runtime.GOARCH)
	// A syntactically valid but wrong checksum line.
	wrongSums := fmt.Sprintf("%064x  %s\n", 0, binName)
	rel, client, closeSrv := fakeRelease(t, "argus-bg", payload, wrongSums)
	defer closeSrv()

	dest := filepath.Join(t.TempDir(), "argus-bg")
	logger := log.New(io.Discard, "", 0)
	err := installFromRelease(context.Background(), client, logger, rel, "argus-bg", dest)
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("err = %v, want checksum mismatch", err)
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Errorf("destination should not exist after a failed install, stat err = %v", statErr)
	}
}

// TestInstallFromReleaseMissingAsset covers a release that lacks the binary
// for this OS/arch (e.g. an old release published before argus-bg shipped):
// we surface a clear error rather than panicking or installing garbage.
func TestInstallFromReleaseMissingAsset(t *testing.T) {
	rel := &release{TagName: "argus-sidecar-v1.2.3", Assets: nil}
	logger := log.New(io.Discard, "", 0)
	err := installFromRelease(context.Background(), &http.Client{}, logger, rel, "argus-bg", filepath.Join(t.TempDir(), "argus-bg"))
	if err == nil || !strings.Contains(err.Error(), "no asset named") {
		t.Fatalf("err = %v, want missing-asset error", err)
	}
}

// TestParseCompanionVersion pins the "<name> <version> <goos>/<goarch>"
// parsing both binaries' `version` output shares — including extra
// whitespace — and confirms unparseable lines are rejected (so the probe
// fails safe rather than returning a bogus version).
func TestParseCompanionVersion(t *testing.T) {
	ok := []struct{ in, want string }{
		{"argus-bg argus-sidecar-v1.2.3 linux/amd64\n", "argus-sidecar-v1.2.3"},
		{"argus-bg dev darwin/arm64\n", "dev"},
		{"  argus-bg   argus-sidecar-v9.9.9   linux/amd64  \n", "argus-sidecar-v9.9.9"},
	}
	for _, tc := range ok {
		got, err := parseCompanionVersion(tc.in)
		if err != nil || got != tc.want {
			t.Errorf("parseCompanionVersion(%q) = (%q, %v), want (%q, nil)", tc.in, got, err, tc.want)
		}
	}
	bad := []string{"", "\n", "argus-bg\n", "   \n"}
	for _, in := range bad {
		if got, err := parseCompanionVersion(in); err == nil {
			t.Errorf("parseCompanionVersion(%q) = (%q, nil), want error", in, got)
		}
	}
}

// TestCompanionUpToDateMissing exercises the fail-safe path: with no companion
// binary next to the test executable, the version probe fails and
// CompanionUpToDate must report "not up to date" (so the caller re-installs)
// with an empty detected version.
func TestCompanionUpToDateMissing(t *testing.T) {
	upToDate, installed := CompanionUpToDate("argus-bg-nonexistent-xyz", "argus-sidecar-v1.0.0")
	if upToDate {
		t.Errorf("CompanionUpToDate(missing) upToDate = true, want false")
	}
	if installed != "" {
		t.Errorf("CompanionUpToDate(missing) installed = %q, want empty", installed)
	}
}

// TestCompanionPath confirms a companion resolves to a sibling of the running
// executable (the directory the daemon prepends to PATH for spawned shells).
func TestCompanionPath(t *testing.T) {
	p, err := CompanionPath("argus-bg")
	if err != nil {
		t.Fatalf("CompanionPath: %v", err)
	}
	if filepath.Base(p) != "argus-bg" {
		t.Errorf("CompanionPath base = %q, want argus-bg", filepath.Base(p))
	}
	exe, err := resolveExe()
	if err != nil {
		t.Fatalf("resolveExe: %v", err)
	}
	if filepath.Dir(p) != filepath.Dir(exe) {
		t.Errorf("CompanionPath dir = %q, want %q", filepath.Dir(p), filepath.Dir(exe))
	}
}
