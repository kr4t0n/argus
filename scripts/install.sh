#!/usr/bin/env sh
# argus-sidecar installer
#
#   curl -LsSf https://raw.githubusercontent.com/kr4t0n/argus/main/scripts/install.sh | sh
#
# What this does:
#   1. Detects your OS (darwin | linux) and architecture (amd64 | arm64).
#   2. Resolves the latest stable `argus-sidecar-v*` release (or whatever
#      you pin via $ARGUS_VERSION).
#   3. Downloads the matching binary and SHASUMS256.txt from the GitHub
#      release, verifies the SHA-256, and installs to $ARGUS_INSTALL_DIR
#      (defaults to /usr/local/bin if writable, else $HOME/.local/bin).
#   4. Tells you whether you need to add the install dir to your PATH.
#
# Rate limits: api.github.com allows 60 unauthenticated requests per hour
# per IP, which a fleet sharing one NAT egress can exhaust mid-rollout —
# the failure looks like an auth error, not a quota one. So the default
# path never touches the API: releases are resolved from the repo's Atom
# feed and assets are pulled from the /releases/download/ redirect, both
# on github.com and both outside that budget. Setting GITHUB_TOKEN opts
# back into the API, which is what private repos need anyway.
#
# Environment variables:
#   ARGUS_VERSION       Pin a specific release tag (e.g. argus-sidecar-v0.1.0).
#                       Defaults to the newest published release. Pinning
#                       skips resolution entirely — no listing request.
#   ARGUS_PRERELEASE    Set to 1 to consider `-rc`/`-alpha`/`-beta` tags.
#                       Off by default, matching `argus-sidecar update`.
#   ARGUS_INSTALL_DIR   Override the install directory.
#   GITHUB_TOKEN        Personal access token for private repo / higher
#                       rate limit. Forwarded as `Authorization: Bearer …`,
#                       and switches resolution back to the REST API.
#
# Re-running is safe: the install is an atomic mv over any existing binary.
#
# This script is POSIX sh (no bashisms) so it runs under whatever
# /bin/sh the user has — dash on Debian, ash on Alpine, etc.

set -eu

REPO_DEFAULT="kr4t0n/argus"
REPO="${ARGUS_REPO:-$REPO_DEFAULT}"
TAG_PREFIX="argus-sidecar-v"
BIN_NAME="argus-sidecar"

# Origins, overridable so a mirror / enterprise instance can be pointed at.
GH_WEB="${ARGUS_GITHUB_WEB:-https://github.com}"
GH_API="${ARGUS_GITHUB_API:-https://api.github.com}"

# A token means either a private repo (whose Atom feed is not public) or
# 5000 req/h, so in both cases the REST API is the better resolver.
if [ -n "${GITHUB_TOKEN:-}" ]; then USE_API=1; else USE_API=0; fi

# How many candidate tags to try before giving up. A tag whose release
# workflow is still running is published (and therefore in the feed)
# minutes before its assets are, so the newest tag is not always
# installable; more than a couple in a row means something else is wrong.
MAX_CANDIDATES=3

# ── Pretty output (only when stderr is a TTY) ─────────────────────────
if [ -t 2 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
    BOLD=$(tput bold); DIM=$(tput dim); RED=$(tput setaf 1); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RESET=$(tput sgr0)
else
    BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

info()  { printf '%s==>%s %s\n' "$BOLD$GREEN" "$RESET" "$*" >&2; }
warn()  { printf '%s!! %s%s\n'  "$YELLOW" "$*" "$RESET" >&2; }
error() { printf '%sxx %s%s\n'  "$RED" "$*" "$RESET" >&2; }
die()   { error "$*"; exit 1; }

# ── Sanity checks ─────────────────────────────────────────────────────
need_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "required command '$1' not found"
}
need_cmd uname
need_cmd mkdir
need_cmd mv
need_cmd chmod

# ── OS / arch detection ───────────────────────────────────────────────
detect_os() {
    case "$(uname -s)" in
        Linux*)   echo linux ;;
        Darwin*)  echo darwin ;;
        *)        die "unsupported OS: $(uname -s) — argus-sidecar only ships linux/darwin binaries" ;;
    esac
}

detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64)   echo amd64 ;;
        arm64|aarch64)  echo arm64 ;;
        *)              die "unsupported architecture: $(uname -m) — argus-sidecar only ships amd64/arm64 binaries" ;;
    esac
}

OS=$(detect_os)
ARCH=$(detect_arch)
ASSET="${BIN_NAME}-${OS}-${ARCH}"
# argus-bg is the per-shell wrapper that exposes a long-running
# command's tqdm progress to the dashboard's Progress tab. It ships
# alongside the sidecar; older releases predate it, so the install
# pass below treats it as optional and gracefully skips the install
# when the asset isn't in SHASUMS256.txt.
BG_ASSET="argus-bg-${OS}-${ARCH}"
BG_BIN_NAME="argus-bg"

# ── Pick a downloader (curl > wget) ───────────────────────────────────
if command -v curl >/dev/null 2>&1; then
    DOWNLOADER=curl
elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER=wget
else
    die "neither curl nor wget found — install one of them and retry"
fi

http_get() {
    # Usage: http_get URL OUTFILE
    # Pipes auth header through whichever tool is available. Fails on
    # any non-2xx response (curl: -f; wget: --content-on-error sense).
    _url="$1"; _out="$2"
    if [ "$DOWNLOADER" = "curl" ]; then
        if [ -n "${GITHUB_TOKEN:-}" ]; then
            curl --fail --silent --show-error --location \
                 --header "Authorization: Bearer $GITHUB_TOKEN" \
                 --header "Accept: application/vnd.github+json" \
                 "$_url" -o "$_out"
        else
            curl --fail --silent --show-error --location "$_url" -o "$_out"
        fi
    else
        if [ -n "${GITHUB_TOKEN:-}" ]; then
            wget --quiet \
                 --header "Authorization: Bearer $GITHUB_TOKEN" \
                 --header "Accept: application/vnd.github+json" \
                 "$_url" -O "$_out"
        else
            wget --quiet "$_url" -O "$_out"
        fi
    fi
}

# Same as above but downloads as octet-stream — required to fetch private
# release assets via the API URL (browser_download_url 404s for those).
http_get_asset() {
    _url="$1"; _out="$2"
    if [ "$DOWNLOADER" = "curl" ]; then
        if [ -n "${GITHUB_TOKEN:-}" ]; then
            curl --fail --silent --show-error --location \
                 --header "Authorization: Bearer $GITHUB_TOKEN" \
                 --header "Accept: application/octet-stream" \
                 "$_url" -o "$_out"
        else
            curl --fail --silent --show-error --location \
                 --header "Accept: application/octet-stream" \
                 "$_url" -o "$_out"
        fi
    else
        if [ -n "${GITHUB_TOKEN:-}" ]; then
            wget --quiet \
                 --header "Authorization: Bearer $GITHUB_TOKEN" \
                 --header "Accept: application/octet-stream" \
                 "$_url" -O "$_out"
        else
            wget --quiet --header "Accept: application/octet-stream" "$_url" -O "$_out"
        fi
    fi
}

# ── Pick a sha256 implementation ──────────────────────────────────────
if command -v sha256sum >/dev/null 2>&1; then
    sha256() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
    sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
else
    die "neither sha256sum nor shasum available — cannot verify download integrity"
fi

# ── Resolve install dir ───────────────────────────────────────────────
# Precedence: $ARGUS_INSTALL_DIR > /usr/local/bin (if writable) > $HOME/.local/bin
resolve_install_dir() {
    if [ -n "${ARGUS_INSTALL_DIR:-}" ]; then
        echo "$ARGUS_INSTALL_DIR"
        return
    fi
    if [ -w /usr/local/bin ] 2>/dev/null; then
        echo /usr/local/bin
        return
    fi
    echo "$HOME/.local/bin"
}
INSTALL_DIR=$(resolve_install_dir)

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
RELEASE_JSON="$TMP_DIR/release.json"

# ── Resolve version ───────────────────────────────────────────────────
# rank_tags reads candidate tags on stdin and prints the installable ones,
# newest first. Ordering is by SemVer precedence rather than publish
# order, because a late patch on an older line is published after a newer
# release and would otherwise win. Prerelease-ness is derived from the tag
# suffix — the Atom feed carries no prerelease flag, and the release
# workflow sets GitHub's flag from that same suffix, so the tag is the
# source of truth either way.
rank_tags() {
    awk -v prefix="$TAG_PREFIX" -v want_pre="${ARGUS_PRERELEASE:-0}" '
        {
            tag = $0
            ver = substr(tag, length(prefix) + 1)
            pre = ""
            i = index(ver, "-")
            if (i > 0) { pre = substr(ver, i + 1); ver = substr(ver, 1, i - 1) }
            if (pre != "" && want_pre != "1") next
            if (split(ver, p, ".") != 3) next
            for (j = 1; j <= 3; j++) if (p[j] !~ /^[0-9]+$/) next
            if (seen[tag]++) next
            # First number in the prerelease id, so rc.10 outranks rc.2.
            prenum = 0
            if (pre != "") { m = pre; sub(/^[^0-9]*/, "", m); if (m ~ /^[0-9]/) prenum = m + 0 }
            # Fixed-width key so a plain reverse sort orders correctly
            # everywhere (BSD sort has no -V).
            printf "%05d%05d%05d%d%05d %s\n", p[1], p[2], p[3], (pre == "" ? 1 : 0), prenum, tag
        }
    ' | sort -r | awk '{print $2}'
}

# The Atom feed is one unauthenticated GET on github.com and costs nothing
# against the REST quota. It returns only the ten most recent entries
# repo-wide, so a burst of another component's releases can hide every
# sidecar tag — that is what the API resolver below is still here for.
resolve_tags_feed() {
    _feed="$TMP_DIR/releases.atom"
    http_get "$GH_WEB/${REPO}/releases.atom" "$_feed" || return 1
    grep -oE "/releases/tag/${TAG_PREFIX}[A-Za-z0-9._+-]+" "$_feed" \
        | sed -e 's|.*/releases/tag/||' \
        | rank_tags
}

resolve_tags_api() {
    _list="$TMP_DIR/releases.json"
    http_get "$GH_API/repos/${REPO}/releases?per_page=30" "$_list" || return 1
    grep -E '"tag_name": *"' "$_list" \
        | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' \
        | rank_tags
}

if [ -n "${ARGUS_VERSION:-}" ]; then
    # Allow callers to pass either `0.1.0` or `argus-sidecar-v0.1.0`.
    # A pin needs no listing request at all.
    case "$ARGUS_VERSION" in
        ${TAG_PREFIX}*) CANDIDATES="$ARGUS_VERSION" ;;
        *)              CANDIDATES="${TAG_PREFIX}${ARGUS_VERSION}" ;;
    esac
else
    info "resolving latest release of $REPO …"
    CANDIDATES=""
    if [ "$USE_API" = "0" ]; then
        CANDIDATES=$(resolve_tags_feed || true)
        [ -n "$CANDIDATES" ] || warn "no usable tag in the release feed — falling back to the releases API"
    fi
    if [ -z "$CANDIDATES" ]; then
        CANDIDATES=$(resolve_tags_api) \
            || die "couldn't list releases — repo private without GITHUB_TOKEN, or network down"
    fi
    [ -n "$CANDIDATES" ] || die "no release tagged ${TAG_PREFIX}* found in $REPO"
fi

# ── Locate the release's assets ───────────────────────────────────────
# Pull the API URL of the asset whose `name` matches our binary or SHASUMS
# file. We extract the asset `id` (the `name` field is several lines deeper
# inside each asset object than `url`, so naive paired-line parsing latches
# onto the wrong url — typically `uploader.url`). The id-then-construct
# approach is jq-free and immune to property reordering.
asset_api_url() {
    _name="$1"
    _id=$(awk -v want="$_name" '
        # Each asset starts with "id": <number>. Stash it; if the next
        # "name" we see in this same object matches, emit the id.
        /"id":/ {
            match($0, /"id": *[0-9]+/); cur = substr($0, RSTART+5, RLENGTH-5)
            gsub(/[ \t]+/, "", cur); pending = cur
        }
        /"name":/ {
            match($0, /"name": *"[^"]*"/); n = substr($0, RSTART+9, RLENGTH-10)
            if (n == want && pending != "") { print pending; exit }
        }
    ' "$RELEASE_JSON")
    [ -n "$_id" ] && printf '%s/repos/%s/releases/assets/%s\n' "$GH_API" "$REPO" "$_id"
}

# In API mode assets are addressed by id, which is what makes private
# repos work once GITHUB_TOKEN is set. Otherwise we construct the public
# /releases/download/ URL, which 302s to the release-assets CDN — no
# listing request, no API quota.
asset_url() {
    if [ "$USE_API" = "1" ]; then
        asset_api_url "$1"
    else
        printf '%s/%s/releases/download/%s/%s\n' "$GH_WEB" "$REPO" "$TAG" "$1"
    fi
}

# Fetch a candidate's checksum manifest. Doubles as the "are this
# release's assets published yet?" probe: a tag is public the moment it's
# pushed, but its binaries only exist once the release workflow finishes,
# so the newest tag is briefly uninstallable after every cut.
prepare_release() {
    _tag="$1"
    if [ "$USE_API" = "1" ]; then
        http_get "$GH_API/repos/${REPO}/releases/tags/${_tag}" "$RELEASE_JSON" || return 1
        _sums=$(asset_api_url "SHASUMS256.txt")
    else
        _sums="$GH_WEB/${REPO}/releases/download/${_tag}/SHASUMS256.txt"
    fi
    [ -n "$_sums" ] || return 1
    http_get_asset "$_sums" "$TMP_DIR/SHASUMS256.txt" || return 1
}

TAG=""
_tried=0
for _cand in $CANDIDATES; do
    _tried=$((_tried + 1))
    [ "$_tried" -le "$MAX_CANDIDATES" ] || break
    info "checking $_cand …"
    if prepare_release "$_cand"; then
        TAG="$_cand"
        break
    fi
    warn "$_cand has no downloadable assets — its build may still be running"
done
[ -n "$TAG" ] || die "no installable release found (tried $_tried) — retry in a few minutes, or pin one with ARGUS_VERSION"

info "installing $TAG ($OS/$ARCH) → $INSTALL_DIR/$BIN_NAME"

# ── Install one asset: download → verify → atomic mv ─────────────────
# Refactored from the original single-binary path so we can install
# argus-bg the same way without duplicating the SHA-256 dance.
install_asset() {
    _asset="$1"; _install_as="$2"
    _url=$(asset_url "$_asset")
    [ -n "$_url" ] || die "release $TAG is missing asset $_asset"
    _expected=$(awk -v a="$_asset" '$2==a {print $1}' "$TMP_DIR/SHASUMS256.txt")
    [ -n "$_expected" ] || die "$_asset not present in SHASUMS256.txt"
    info "downloading $_asset …"
    http_get_asset "$_url" "$TMP_DIR/$_asset"
    _got=$(sha256 "$TMP_DIR/$_asset")
    if [ "$_expected" != "$_got" ]; then
        die "checksum mismatch for $_asset — expected $_expected, got $_got"
    fi
    info "checksum verified for $_install_as (sha256 ${DIM}$_got${RESET})"
    chmod 0755 "$TMP_DIR/$_asset"
    mv -f "$TMP_DIR/$_asset" "$INSTALL_DIR/$_install_as"
}

# ── Install ──────────────────────────────────────────────────────────
if [ ! -d "$INSTALL_DIR" ]; then
    mkdir -p "$INSTALL_DIR" 2>/dev/null \
        || die "could not create $INSTALL_DIR (run with elevated privileges or set ARGUS_INSTALL_DIR)"
fi

if [ ! -w "$INSTALL_DIR" ]; then
    die "$INSTALL_DIR is not writable — re-run with sudo, or set ARGUS_INSTALL_DIR=\$HOME/.local/bin"
fi

install_asset "$ASSET" "$BIN_NAME"

# Best-effort install of argus-bg. The Progress dashboard tab depends
# on it being on PATH inside the sidecar's spawned shells — the
# sidecar prepends its own bin dir to PATH so dropping argus-bg here
# is sufficient. Older releases predate this binary; skip cleanly so
# the rest of the install isn't broken for them.
if awk -v a="$BG_ASSET" '$2==a {found=1} END{exit !found}' "$TMP_DIR/SHASUMS256.txt"; then
    install_asset "$BG_ASSET" "$BG_BIN_NAME"
    INSTALLED_BG=1
else
    warn "release $TAG does not ship $BG_ASSET — Progress tab will be empty until you upgrade"
    INSTALLED_BG=0
fi

# ── Post-install: PATH check + version banner ─────────────────────────
case ":$PATH:" in
    *":$INSTALL_DIR:"*)
        info "$BIN_NAME installed:"
        "$INSTALL_DIR/$BIN_NAME" version
        [ "$INSTALLED_BG" = "1" ] && info "$BG_BIN_NAME installed at $INSTALL_DIR/$BG_BIN_NAME"
        ;;
    *)
        info "$BIN_NAME installed at $INSTALL_DIR/$BIN_NAME"
        [ "$INSTALLED_BG" = "1" ] && info "$BG_BIN_NAME installed at $INSTALL_DIR/$BG_BIN_NAME"
        warn "$INSTALL_DIR is not on your PATH. Add this to your shell profile:"
        printf '\n    export PATH="%s:$PATH"\n\n' "$INSTALL_DIR" >&2
        printf '%sThen reload your shell, or invoke directly:%s %s/%s version\n' \
            "$DIM" "$RESET" "$INSTALL_DIR" "$BIN_NAME" >&2
        ;;
esac

cat <<EOF >&2

${BOLD}Next steps${RESET}
  - One-time setup (interactive):  ${BIN_NAME} init
        scripted:                  ${BIN_NAME} init --bus REDIS_URL --server https://argus.your.tld --token \$SIDECAR_LINK_TOKEN
  - Run it:                        ${BIN_NAME}
  - Or supervise it (systemd/launchd, unit written for you):
                                   ${BIN_NAME} service install
  - Self-update later with:        ${BIN_NAME} update

EOF
