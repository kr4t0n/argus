// Package updater implements the `argus-sidecar update` self-update flow.
//
// At a high level we:
//
//  1. Hit the GitHub Releases API and pick the newest release whose tag
//     starts with `sidecar-v` (so other components can have their own
//     release cadence in the same repo without confusing us).
//  2. Find the asset matching `argus-sidecar-<goos>-<goarch>` and the
//     companion `SHASUMS256.txt`. Bail with a clear error if either is
//     missing — that means the release wasn't built by our workflow.
//  3. Stream the binary into a temp file alongside the currently running
//     executable, computing SHA-256 as we go. Refuse to swap unless the
//     hash matches the SHASUMS256.txt entry.
//  4. chmod 0755 and `os.Rename` over the running executable. POSIX
//     rename-over-self is atomic and safe: the running process keeps its
//     in-memory image, future invocations get the new binary.
//
// Windows is intentionally not supported — the sidecar only ships
// linux/darwin binaries.
package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// DefaultRepo points at the canonical Argus repo. Overridable from the CLI
// so forks / staging mirrors can self-update too.
const DefaultRepo = "kr4t0n/argus"

// tagPrefix scopes which releases we consider. Lets future component
// releases (e.g. `web-v1.0.0`) coexist without mass-confusion.
const tagPrefix = "sidecar-v"

// Options controls a single update run. Zero values pick safe defaults
// (kr4t0n/argus, stable releases only, std logger).
type Options struct {
	Repo              string      // owner/name; defaults to DefaultRepo
	IncludePrerelease bool        // include releases marked prerelease
	CurrentVersion    string      // for "already up to date" detection; "" => always update
	Force             bool        // re-download even if already on latest
	HTTPClient        *http.Client // optional override; defaults to a 60s-timeout client
	Logger            *log.Logger
}

type release struct {
	TagName    string  `json:"tag_name"`
	Name       string  `json:"name"`
	Draft      bool    `json:"draft"`
	Prerelease bool    `json:"prerelease"`
	HTMLURL    string  `json:"html_url"`
	Assets     []asset `json:"assets"`
}

type asset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

// Update performs the full update flow. Returns the tag we updated to (or
// the current tag, if already up to date) plus an error describing any
// failure. The current executable is unchanged unless we successfully
// completed the swap.
func Update(ctx context.Context, opts Options) (string, error) {
	repo := opts.Repo
	if repo == "" {
		repo = DefaultRepo
	}
	logger := opts.Logger
	if logger == nil {
		logger = log.Default()
	}
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}

	rel, err := pickLatestRelease(ctx, client, repo, opts.IncludePrerelease)
	if err != nil {
		return "", err
	}
	logger.Printf("latest release: %s (%s)", rel.TagName, rel.HTMLURL)

	if !opts.Force && opts.CurrentVersion != "" && opts.CurrentVersion == rel.TagName {
		logger.Printf("already on %s — nothing to do", rel.TagName)
		return rel.TagName, nil
	}

	binAssetName := fmt.Sprintf("argus-sidecar-%s-%s", runtime.GOOS, runtime.GOARCH)
	binAsset := findAsset(rel.Assets, binAssetName)
	if binAsset == nil {
		return "", fmt.Errorf("release %s has no asset named %q (built for an unsupported platform?)", rel.TagName, binAssetName)
	}
	sumsAsset := findAsset(rel.Assets, "SHASUMS256.txt")
	if sumsAsset == nil {
		return "", fmt.Errorf("release %s has no SHASUMS256.txt — refusing to update without checksum", rel.TagName)
	}

	expectedSum, err := fetchExpectedChecksum(ctx, client, sumsAsset.BrowserDownloadURL, binAssetName)
	if err != nil {
		return "", fmt.Errorf("fetch checksum: %w", err)
	}

	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("locate current executable: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("resolve executable symlink: %w", err)
	}

	logger.Printf("downloading %s (%.1f MB)…", binAsset.Name, float64(binAsset.Size)/1024/1024)
	tmpPath, gotSum, err := downloadToTemp(ctx, client, binAsset.BrowserDownloadURL, exe)
	if err != nil {
		return "", fmt.Errorf("download binary: %w", err)
	}
	// If anything below fails, leave nothing behind on disk.
	defer func() {
		if _, statErr := os.Stat(tmpPath); statErr == nil {
			_ = os.Remove(tmpPath)
		}
	}()

	if !strings.EqualFold(gotSum, expectedSum) {
		return "", fmt.Errorf("checksum mismatch: expected %s, got %s", expectedSum, gotSum)
	}
	logger.Printf("checksum verified (sha256 %s)", gotSum)

	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return "", fmt.Errorf("chmod temp binary: %w", err)
	}

	// Atomic swap. On POSIX this works even if the file is currently being
	// executed: the running process keeps the old inode (and its mmap'd
	// pages) until exit; new invocations get the new file.
	if err := os.Rename(tmpPath, exe); err != nil {
		return "", fmt.Errorf("install new binary at %s: %w", exe, err)
	}

	logger.Printf("updated %s -> %s", exe, rel.TagName)
	logger.Printf("restart any running sidecar processes to pick up the new binary")
	return rel.TagName, nil
}

// pickLatestRelease lists recent releases and returns the newest one whose
// tag starts with `sidecar-v`. The GitHub `/releases` endpoint already
// returns results in descending publish order so the first match is the
// newest. We deliberately do NOT use `/releases/latest` because that
// endpoint always returns the single newest release across the whole
// repository, which could be a different component (e.g. a future
// `web-v1.0.0`).
func pickLatestRelease(ctx context.Context, client *http.Client, repo string, includePrerelease bool) (*release, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/releases?per_page=30", repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if tok := os.Getenv("GITHUB_TOKEN"); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("query releases: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("releases api: %s — %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var releases []release
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, fmt.Errorf("decode releases: %w", err)
	}
	for i := range releases {
		r := &releases[i]
		if r.Draft {
			continue
		}
		if r.Prerelease && !includePrerelease {
			continue
		}
		if !strings.HasPrefix(r.TagName, tagPrefix) {
			continue
		}
		return r, nil
	}
	return nil, errors.New("no matching sidecar release found")
}

func findAsset(assets []asset, name string) *asset {
	for i := range assets {
		if assets[i].Name == name {
			return &assets[i]
		}
	}
	return nil
}

// fetchExpectedChecksum downloads SHASUMS256.txt and finds the line for
// the given filename. Format mirrors GNU `sha256sum`:
//
//	<hex-digest>  <filename>
func fetchExpectedChecksum(ctx context.Context, client *http.Client, url, filename string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("checksum file: %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == filename {
			return strings.ToLower(fields[0]), nil
		}
	}
	return "", fmt.Errorf("filename %q not present in SHASUMS256.txt", filename)
}

// downloadToTemp streams the asset into a temp file in the same directory
// as `nearby`, returns the temp path and the SHA-256 of what we wrote.
// Same-directory placement is required so the final os.Rename is atomic
// (cross-filesystem rename would fall back to copy-then-delete).
func downloadToTemp(ctx context.Context, client *http.Client, url, nearby string) (string, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("download: %s", resp.Status)
	}

	dir := filepath.Dir(nearby)
	tmp, err := os.CreateTemp(dir, ".argus-sidecar-update-*")
	if err != nil {
		return "", "", err
	}
	tmpPath := tmp.Name()

	hasher := sha256.New()
	w := io.MultiWriter(tmp, hasher)
	if _, err := io.Copy(w, resp.Body); err != nil {
		tmp.Close()
		_ = os.Remove(tmpPath)
		return "", "", err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return "", "", err
	}
	return tmpPath, hex.EncodeToString(hasher.Sum(nil)), nil
}
