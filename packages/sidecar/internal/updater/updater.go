// Package updater implements the `argus-sidecar update` self-update flow.
//
// At a high level we:
//
//  1. Resolve the newest release whose tag starts with `argus-sidecar-v`
//     (so other components can have their own release cadence in the same
//     repo without confusing us). Two resolvers, see "Rate limits" below.
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
// # Rate limits
//
// api.github.com allows 60 unauthenticated requests per hour keyed on the
// client IP. A fleet of sidecars behind one NAT egress shares that budget,
// so a rollout across a dozen machines could exhaust it and fail with a
// 403 that reads like an auth problem. Every request we make on the
// default path therefore avoids the REST API entirely:
//
//   - resolution reads github.com/<repo>/releases.atom, a plain web
//     endpoint outside the REST quota, and
//   - assets are fetched from github.com/<repo>/releases/download/<tag>/…,
//     which 302s to the release-assets CDN.
//
// The REST path is retained and used whenever GITHUB_TOKEN is set (private
// repos, and 5000 req/h makes the quota a non-issue) or when the feed
// cannot answer — see pickLatestRelease.
//
// Windows is intentionally not supported — the sidecar only ships
// linux/darwin binaries.
package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// DefaultRepo points at the canonical Argus repo. Overridable from the CLI
// so forks / staging mirrors can self-update too.
const DefaultRepo = "kr4t0n/argus"

// tagPrefix scopes which releases we consider. Lets future component
// releases (e.g. `argus-web-v1.0.0`) coexist without mass-confusion.
const tagPrefix = "argus-sidecar-v"

// githubWebBase is the origin serving releases.atom and the
// /releases/download/ redirects — deliberately NOT api.github.com, since
// avoiding the REST quota is the whole point of the feed resolver. A
// variable so tests can point it at an httptest server.
var githubWebBase = "https://github.com"

// Options controls a single update run. Zero values pick safe defaults
// (kr4t0n/argus, stable releases only, std logger).
type Options struct {
	Repo              string       // owner/name; defaults to DefaultRepo
	IncludePrerelease bool         // include releases marked prerelease
	CurrentVersion    string       // for "already up to date" detection; "" => always update
	Force             bool         // re-download even if already on latest
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

	// assetBaseURL is set only by the feed-based resolver, which never
	// sees an asset listing. When present, asset lookups synthesize a
	// direct download URL under it instead of consulting Assets. See
	// (*release).findAsset.
	assetBaseURL string
}

type asset struct {
	ID                 int64  `json:"id"`
	Name               string `json:"name"`
	URL                string `json:"url"` // api.github.com/repos/.../assets/<id>
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

// downloadURL returns the URL we should actually GET to fetch the asset
// bytes. We prefer the API URL (with Accept: application/octet-stream)
// because it works for both public AND private repos when paired with
// GITHUB_TOKEN — `browser_download_url` 404s on private repos because it
// redirects to a short-lived signed URL that is incompatible with the
// Authorization header.
func (a *asset) downloadURL() string {
	if a.URL != "" {
		return a.URL
	}
	return a.BrowserDownloadURL
}

// resolve fills in the zero-value defaults for an Options (repo, logger,
// client) so the public entry points share one normalization path.
func (o Options) resolve() (repo string, logger *log.Logger, client *http.Client) {
	repo = o.Repo
	if repo == "" {
		repo = DefaultRepo
	}
	logger = o.Logger
	if logger == nil {
		logger = log.Default()
	}
	client = o.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	return repo, logger, client
}

// Update performs the full update flow for the sidecar binary itself.
// Returns the tag we updated to (or the current tag, if already up to date)
// plus an error describing any failure. The current executable is unchanged
// unless we successfully completed the swap.
func Update(ctx context.Context, opts Options) (string, error) {
	repo, logger, client := opts.resolve()

	rel, err := pickLatestRelease(ctx, client, logger, repo, opts.IncludePrerelease)
	if err != nil {
		return "", err
	}
	logger.Printf("latest release: %s (%s)", rel.TagName, rel.HTMLURL)

	if !opts.Force && opts.CurrentVersion != "" && opts.CurrentVersion == rel.TagName {
		logger.Printf("already on %s — nothing to do", rel.TagName)
		return rel.TagName, nil
	}

	exe, err := resolveExe()
	if err != nil {
		return "", err
	}

	if err := installFromRelease(ctx, client, logger, rel, "argus-sidecar", exe); err != nil {
		return "", err
	}
	removeLegacyCompanion(logger, filepath.Dir(exe))

	logger.Printf("updated %s -> %s", exe, rel.TagName)
	logger.Printf("restart any running sidecar processes to pick up the new binary")
	return rel.TagName, nil
}

// removeLegacyCompanion deletes the retired `argus-bg` binary if one is
// still installed next to the sidecar. Releases up to 0.3.x shipped it as
// a sibling and `update` kept it in lockstep; the progress extension it
// fed is gone, so nothing reads it any more and a leftover copy only
// confuses `which argus-bg`. Best-effort: a missing file is the expected
// case, and any other error is logged rather than failing the swap that
// already succeeded.
func removeLegacyCompanion(logger *log.Logger, binDir string) {
	path := filepath.Join(binDir, "argus-bg")
	switch err := os.Remove(path); {
	case err == nil:
		logger.Printf("removed retired companion %s", path)
	case errors.Is(err, os.ErrNotExist):
		// Nothing to sweep — fresh installs never had it.
	default:
		logger.Printf("warning: could not remove retired companion %s: %v", path, err)
	}
}

// resolveExe returns the canonical, symlink-resolved path to the running
// executable. We resolve symlinks so the atomic rename lands on the real file
// (not a symlink).
func resolveExe() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("locate current executable: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("resolve executable symlink: %w", err)
	}
	return exe, nil
}

// installFromRelease downloads the `<assetBase>-<goos>-<goarch>` asset from
// rel, verifies it against the release's SHASUMS256.txt, and atomically
// installs it (0755) at destPath. The temp file is placed in destPath's
// directory so the final rename is atomic (same filesystem). destPath need
// not already exist — only its parent directory must.
func installFromRelease(ctx context.Context, client *http.Client, logger *log.Logger, rel *release, assetBase, destPath string) error {
	binAssetName := fmt.Sprintf("%s-%s-%s", assetBase, runtime.GOOS, runtime.GOARCH)
	binAsset := rel.findAsset(binAssetName)
	if binAsset == nil {
		return fmt.Errorf("release %s has no asset named %q (built for an unsupported platform?)", rel.TagName, binAssetName)
	}
	sumsAsset := rel.findAsset("SHASUMS256.txt")
	if sumsAsset == nil {
		return fmt.Errorf("release %s has no SHASUMS256.txt — refusing to install without checksum", rel.TagName)
	}

	expectedSum, err := fetchExpectedChecksum(ctx, client, sumsAsset.downloadURL(), binAssetName)
	if err != nil {
		return fmt.Errorf("fetch checksum: %w", err)
	}

	// Size is only known on the REST path; the feed resolver has no
	// listing to read it from, so omit it rather than print "0.0 MB".
	if binAsset.Size > 0 {
		logger.Printf("downloading %s (%.1f MB)…", binAsset.Name, float64(binAsset.Size)/1024/1024)
	} else {
		logger.Printf("downloading %s…", binAsset.Name)
	}
	tmpPath, gotSum, err := downloadToTemp(ctx, client, binAsset.downloadURL(), destPath)
	if err != nil {
		return fmt.Errorf("download binary: %w", err)
	}
	// If anything below fails, leave nothing behind on disk.
	defer func() {
		if _, statErr := os.Stat(tmpPath); statErr == nil {
			_ = os.Remove(tmpPath)
		}
	}()

	if !strings.EqualFold(gotSum, expectedSum) {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedSum, gotSum)
	}
	logger.Printf("checksum verified (sha256 %s)", gotSum)

	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return fmt.Errorf("chmod temp binary: %w", err)
	}

	// Atomic swap. On POSIX this works even if the file is currently being
	// executed: the running process keeps the old inode (and its mmap'd
	// pages) until exit; new invocations get the new file.
	if err := os.Rename(tmpPath, destPath); err != nil {
		return fmt.Errorf("install new binary at %s: %w", destPath, err)
	}
	return nil
}

// pickLatestRelease resolves the newest `argus-sidecar-v*` release,
// preferring the quota-free feed resolver and falling back to the REST API.
//
// The fallback is not just for errors: a token means the caller either has
// a private repo (whose feed is not public) or 5000 req/h, and in both
// cases the API is the better answer. A feed miss also legitimately happens
// on a public repo — releases.atom returns only the ten most recent entries
// repo-wide, so a burst of non-sidecar releases can push every sidecar tag
// out of the window.
func pickLatestRelease(ctx context.Context, client *http.Client, logger *log.Logger, repo string, includePrerelease bool) (*release, error) {
	if os.Getenv("GITHUB_TOKEN") == "" {
		rel, err := pickLatestReleaseFeed(ctx, client, logger, repo, includePrerelease)
		if err == nil {
			return rel, nil
		}
		logger.Printf("release feed unusable (%v) — falling back to the releases API", err)
	}
	return pickLatestReleaseAPI(ctx, client, repo, includePrerelease)
}

// maxFeedCandidates bounds how many tags the feed resolver will probe
// before giving up and letting the API fallback answer. More than a
// couple of consecutive asset-less tags means something is wrong that a
// longer scan will not fix.
const maxFeedCandidates = 3

// pickLatestReleaseFeed resolves the newest matching tag from
// github.com/<repo>/releases.atom — a plain web endpoint, so it costs
// nothing against the REST quota that a NAT'd fleet shares.
//
// Two properties of the feed shape this:
//
//   - It carries no prerelease flag. We derive it from the tag instead,
//     which is sound because the release workflow does the same thing in
//     reverse: it sets GitHub's prerelease flag from a regex on the tag.
//     A tag with any SemVer prerelease part is treated as a prerelease,
//     which is marginally broader than the workflow's rc|alpha|beta|pre
//     and errs toward excluding rather than shipping something unexpected.
//   - It lists bare tags as well as published releases. A tag pushed
//     minutes ago whose build has not finished has no assets yet, so we
//     probe SHASUMS256.txt and fall through to the next candidate rather
//     than resolving to a release nobody can download.
func pickLatestReleaseFeed(ctx context.Context, client *http.Client, logger *log.Logger, repo string, includePrerelease bool) (*release, error) {
	tags, err := fetchReleaseTags(ctx, client, repo)
	if err != nil {
		return nil, err
	}
	candidates := rankSidecarTags(tags, includePrerelease)
	if len(candidates) == 0 {
		return nil, errors.New("no matching sidecar release in the release feed")
	}
	for i, tag := range candidates {
		if i >= maxFeedCandidates {
			break
		}
		base := fmt.Sprintf("%s/%s/releases/download/%s", githubWebBase, repo, tag)
		if err := assetReachable(ctx, client, base+"/SHASUMS256.txt"); err != nil {
			logger.Printf("skipping %s: assets not published yet (%v)", tag, err)
			continue
		}
		return &release{
			TagName:      tag,
			HTMLURL:      fmt.Sprintf("%s/%s/releases/tag/%s", githubWebBase, repo, tag),
			assetBaseURL: base,
		}, nil
	}
	return nil, errors.New("no candidate release had downloadable assets")
}

// atomFeed is the subset of the Atom document we care about: each entry's
// alternate link, whose path ends in the tag name.
type atomFeed struct {
	XMLName xml.Name `xml:"feed"`
	Entries []struct {
		Link struct {
			Href string `xml:"href,attr"`
		} `xml:"link"`
	} `xml:"entry"`
}

func fetchReleaseTags(ctx context.Context, client *http.Client, repo string) ([]string, error) {
	url := fmt.Sprintf("%s/%s/releases.atom", githubWebBase, repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/atom+xml")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch release feed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("release feed: %s", resp.Status)
	}

	var feed atomFeed
	// 1 MB ceiling: the feed is ~16 KB for ten entries, so anything
	// approaching this is a proxy or captive portal serving us HTML.
	if err := xml.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&feed); err != nil {
		return nil, fmt.Errorf("decode release feed: %w", err)
	}

	const marker = "/releases/tag/"
	tags := make([]string, 0, len(feed.Entries))
	for _, e := range feed.Entries {
		if idx := strings.Index(e.Link.Href, marker); idx >= 0 {
			tags = append(tags, e.Link.Href[idx+len(marker):])
		}
	}
	return tags, nil
}

// rankSidecarTags filters raw tags down to well-formed `argus-sidecar-v*`
// ones the caller is willing to install, newest first. Ordering is by
// SemVer precedence rather than feed order, which is by publish time and
// therefore wrong whenever a patch for an older line lands late.
func rankSidecarTags(tags []string, includePrerelease bool) []string {
	type candidate struct{ tag, ver string }
	var out []candidate
	seen := make(map[string]bool, len(tags))
	for _, tag := range tags {
		if seen[tag] || !strings.HasPrefix(tag, tagPrefix) {
			continue
		}
		ver := strings.TrimPrefix(tag, tagPrefix)
		if !isValidVersion(ver) {
			continue
		}
		if strings.Contains(ver, "-") && !includePrerelease {
			continue
		}
		seen[tag] = true
		out = append(out, candidate{tag: tag, ver: ver})
	}
	sort.Slice(out, func(i, j int) bool {
		return compareVersion(out[i].ver, out[j].ver) > 0
	})
	ranked := make([]string, len(out))
	for i, c := range out {
		ranked[i] = c.tag
	}
	return ranked
}

// assetReachable confirms a release asset exists before we commit to its
// tag. HEAD follows the 302 to the CDN and transfers no body, so this is
// cheap enough to run per candidate.
func assetReachable(ctx context.Context, client *http.Client, url string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HEAD %s: %s", url, resp.Status)
	}
	return nil
}

// pickLatestReleaseAPI lists recent releases and returns the highest-versioned
// one whose tag starts with `argus-sidecar-v`. We deliberately do NOT use
// `/releases/latest` because that endpoint always returns the single newest
// release across the whole repository, which could be a different component
// (e.g. a future `argus-web-v1.0.0`).
//
// We also can't trust the API's response order: GitHub's `/releases` listing
// isn't strictly sorted by semver or even by published_at — empirically a
// stable v0.1.11 can appear above a later-published v0.1.12-rc.1 — so picking
// "the first matching release" returned a stale version when --prerelease was
// set. Instead we filter all returned releases by prefix + draft/prerelease
// flags, then pick the max by semver-compliant version comparison.
func pickLatestReleaseAPI(ctx context.Context, client *http.Client, repo string, includePrerelease bool) (*release, error) {
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
	var best *release
	var bestVer string
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
		ver := strings.TrimPrefix(r.TagName, tagPrefix)
		if !isValidVersion(ver) {
			// Tag with our prefix but unparseable suffix — skip rather than
			// risk picking a malformed release. Logged-out so a malformed
			// tag never silently shadows a valid one.
			continue
		}
		if best == nil || compareVersion(ver, bestVer) > 0 {
			best = r
			bestVer = ver
		}
	}
	if best == nil {
		return nil, errors.New("no matching sidecar release found")
	}
	return best, nil
}

// compareVersion compares two version strings of the form
// `MAJOR.MINOR.PATCH[-PRE.IDS]` per SemVer 2.0.0 precedence rules.
// Returns -1 if a < b, 0 if a == b, +1 if a > b. Both inputs must
// have already passed isValidVersion.
func compareVersion(a, b string) int {
	aMain, aPre, _ := strings.Cut(a, "-")
	bMain, bPre, _ := strings.Cut(b, "-")
	if c := compareMain(aMain, bMain); c != 0 {
		return c
	}
	// Per SemVer §11.3: a release version has higher precedence than a
	// prerelease version with the same MAJOR.MINOR.PATCH.
	switch {
	case aPre == "" && bPre == "":
		return 0
	case aPre == "":
		return 1
	case bPre == "":
		return -1
	}
	return comparePrerelease(aPre, bPre)
}

// compareMain compares the dotted MAJOR.MINOR.PATCH portion numerically.
func compareMain(a, b string) int {
	ap := strings.SplitN(a, ".", 3)
	bp := strings.SplitN(b, ".", 3)
	for i := 0; i < 3; i++ {
		ai, _ := strconv.Atoi(ap[i])
		bi, _ := strconv.Atoi(bp[i])
		if ai != bi {
			if ai < bi {
				return -1
			}
			return 1
		}
	}
	return 0
}

// comparePrerelease compares two dot-separated prerelease ID lists per
// SemVer §11.4. Numeric IDs sort numerically, alphanumeric IDs sort
// lexicographically, and numeric IDs always sort below alphanumeric IDs.
// A shorter prefix-equal list sorts below a longer one.
func comparePrerelease(a, b string) int {
	ai := strings.Split(a, ".")
	bi := strings.Split(b, ".")
	n := len(ai)
	if len(bi) < n {
		n = len(bi)
	}
	for i := 0; i < n; i++ {
		if c := compareIdent(ai[i], bi[i]); c != 0 {
			return c
		}
	}
	switch {
	case len(ai) == len(bi):
		return 0
	case len(ai) < len(bi):
		return -1
	default:
		return 1
	}
}

func compareIdent(a, b string) int {
	an, aIsNum := parseUint(a)
	bn, bIsNum := parseUint(b)
	switch {
	case aIsNum && bIsNum:
		switch {
		case an < bn:
			return -1
		case an > bn:
			return 1
		default:
			return 0
		}
	case aIsNum:
		return -1
	case bIsNum:
		return 1
	default:
		switch {
		case a < b:
			return -1
		case a > b:
			return 1
		default:
			return 0
		}
	}
}

func parseUint(s string) (uint64, bool) {
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// isValidVersion accepts MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-PRE.IDS
// where each main part is a non-negative integer and each prerelease ID
// is non-empty. Build metadata (`+...`) is rejected — we don't use it
// in our tag scheme and accepting it would only complicate ordering.
func isValidVersion(v string) bool {
	if strings.ContainsRune(v, '+') {
		return false
	}
	main, pre, hasPre := strings.Cut(v, "-")
	parts := strings.SplitN(main, ".", 3)
	if len(parts) != 3 {
		return false
	}
	for _, p := range parts {
		if _, ok := parseUint(p); !ok {
			return false
		}
	}
	if !hasPre {
		return true
	}
	if pre == "" {
		return false // trailing `-` with no prerelease IDs
	}
	for _, id := range strings.Split(pre, ".") {
		if id == "" {
			return false
		}
	}
	return true
}

// findAsset locates a named asset in the release.
//
// On the REST path we have the real listing, so a miss is authoritative:
// the release genuinely lacks that asset and the caller reports it. On the
// feed path there is no listing at all — only a tag — so we synthesize the
// well-known download URL and let the transfer decide. A synthesized URL
// for an asset that does not exist yields a 404 at download time, which
// pickLatestReleaseFeed has already ruled out for the release it returns
// (it probes SHASUMS256.txt before accepting a tag).
func (r *release) findAsset(name string) *asset {
	for i := range r.Assets {
		if r.Assets[i].Name == name {
			return &r.Assets[i]
		}
	}
	if r.assetBaseURL != "" {
		return &asset{Name: name, BrowserDownloadURL: r.assetBaseURL + "/" + name}
	}
	return nil
}

// newAssetRequest builds a GET request that downloads release-asset
// bytes. The combo of the API URL + `Accept: application/octet-stream`
// + `Authorization: Bearer <token>` is the GitHub-blessed way to
// download assets from private repos. For public repos it works too and
// gracefully degrades when GITHUB_TOKEN is unset.
func newAssetRequest(ctx context.Context, url string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/octet-stream")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if tok := os.Getenv("GITHUB_TOKEN"); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	return req, nil
}

// fetchExpectedChecksum downloads SHASUMS256.txt and finds the line for
// the given filename. Format mirrors GNU `sha256sum`:
//
//	<hex-digest>  <filename>
func fetchExpectedChecksum(ctx context.Context, client *http.Client, url, filename string) (string, error) {
	req, err := newAssetRequest(ctx, url)
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
	req, err := newAssetRequest(ctx, url)
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
