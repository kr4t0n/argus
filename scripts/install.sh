#!/usr/bin/env sh
# argus-sidecar installer
#
#   curl -LsSf https://raw.githubusercontent.com/kr4t0n/argus/main/scripts/install.sh | sh
#
# What this does:
#   1. Detects your OS (darwin | linux) and architecture (amd64 | arm64).
#   2. Resolves the latest `argus-sidecar-v*` release (or whatever you pin
#      via $ARGUS_VERSION).
#   3. Downloads the matching binary and SHASUMS256.txt from the GitHub
#      release, verifies the SHA-256, and installs to $ARGUS_INSTALL_DIR
#      (defaults to /usr/local/bin if writable, else $HOME/.local/bin).
#   4. Tells you whether you need to add the install dir to your PATH.
#
# Environment variables:
#   ARGUS_VERSION       Pin a specific release tag (e.g. argus-sidecar-v0.1.0).
#                       Defaults to the newest published release.
#   ARGUS_INSTALL_DIR   Override the install directory.
#   GITHUB_TOKEN        Personal access token for private repo / higher
#                       rate limit. Forwarded as `Authorization: Bearer …`.
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

# ── Resolve version ───────────────────────────────────────────────────
# Hits the releases API (page 1, 30 entries) and picks the newest
# non-draft release whose tag matches argus-sidecar-v*. Mirrors the
# logic baked into `argus-sidecar update` itself.
resolve_latest_tag() {
    _tmp="$(mktemp)"
    if ! http_get "https://api.github.com/repos/${REPO}/releases?per_page=30" "$_tmp"; then
        rm -f "$_tmp"
        die "couldn't list releases — repo private without GITHUB_TOKEN, or network down"
    fi
    # Grep the tag_name lines; take the first one matching our prefix.
    _tag=$(grep -E '"tag_name": *"' "$_tmp" \
           | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' \
           | grep -E "^${TAG_PREFIX}" \
           | head -n 1)
    rm -f "$_tmp"
    if [ -z "$_tag" ]; then
        die "no release tagged ${TAG_PREFIX}* found in $REPO"
    fi
    echo "$_tag"
}

if [ -n "${ARGUS_VERSION:-}" ]; then
    # Allow callers to pass either `0.1.0` or `argus-sidecar-v0.1.0`.
    case "$ARGUS_VERSION" in
        ${TAG_PREFIX}*) TAG="$ARGUS_VERSION" ;;
        *)              TAG="${TAG_PREFIX}${ARGUS_VERSION}" ;;
    esac
else
    info "resolving latest release of $REPO …"
    TAG=$(resolve_latest_tag)
fi

info "installing $TAG ($OS/$ARCH) → $INSTALL_DIR/$BIN_NAME"

# ── Fetch SHASUMS256.txt → expected hash for our asset ────────────────
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

# Find the release id + asset URLs via the API. We hit /releases/tags
# rather than constructing browser_download_url so private repos work
# the moment GITHUB_TOKEN is set.
RELEASE_JSON="$TMP_DIR/release.json"
if ! http_get "https://api.github.com/repos/${REPO}/releases/tags/${TAG}" "$RELEASE_JSON"; then
    die "couldn't fetch release metadata for $TAG"
fi

# Pull the API URL of the asset whose `name` matches our binary or SHASUMS
# file. We extract the asset `id` (the `name` field is several lines deeper
# inside each asset object than `url`, so naive paired-line parsing latches
# onto the wrong url — typically `uploader.url`). The id-then-construct
# approach is jq-free and immune to property reordering.
asset_url() {
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
    [ -n "$_id" ] && printf 'https://api.github.com/repos/%s/releases/assets/%s\n' "$REPO" "$_id"
}

BIN_URL=$(asset_url "$ASSET")
SUMS_URL=$(asset_url "SHASUMS256.txt")
[ -n "$BIN_URL" ]  || die "release $TAG is missing asset $ASSET (built for an unsupported platform?)"
[ -n "$SUMS_URL" ] || die "release $TAG is missing SHASUMS256.txt — refusing to install without checksum"

info "downloading checksum manifest …"
http_get_asset "$SUMS_URL" "$TMP_DIR/SHASUMS256.txt"
EXPECTED=$(awk -v a="$ASSET" '$2==a {print $1}' "$TMP_DIR/SHASUMS256.txt")
[ -n "$EXPECTED" ] || die "$ASSET not present in SHASUMS256.txt"

info "downloading $ASSET …"
http_get_asset "$BIN_URL" "$TMP_DIR/$ASSET"

GOT=$(sha256 "$TMP_DIR/$ASSET")
if [ "$EXPECTED" != "$GOT" ]; then
    die "checksum mismatch — expected $EXPECTED, got $GOT"
fi
info "checksum verified (sha256 ${DIM}$GOT${RESET})"

# ── Install ──────────────────────────────────────────────────────────
chmod 0755 "$TMP_DIR/$ASSET"

if [ ! -d "$INSTALL_DIR" ]; then
    mkdir -p "$INSTALL_DIR" 2>/dev/null \
        || die "could not create $INSTALL_DIR (run with elevated privileges or set ARGUS_INSTALL_DIR)"
fi

if [ ! -w "$INSTALL_DIR" ]; then
    die "$INSTALL_DIR is not writable — re-run with sudo, or set ARGUS_INSTALL_DIR=\$HOME/.local/bin"
fi

# Atomic mv — works even if the previous binary is currently being
# executed (POSIX rename keeps the running process's inode alive until
# exit; new invocations get the new file).
mv -f "$TMP_DIR/$ASSET" "$INSTALL_DIR/$BIN_NAME"

# ── Post-install: PATH check + version banner ─────────────────────────
case ":$PATH:" in
    *":$INSTALL_DIR:"*)
        info "$BIN_NAME installed:"
        "$INSTALL_DIR/$BIN_NAME" version
        ;;
    *)
        info "$BIN_NAME installed at $INSTALL_DIR/$BIN_NAME"
        warn "$INSTALL_DIR is not on your PATH. Add this to your shell profile:"
        printf '\n    export PATH="%s:$PATH"\n\n' "$INSTALL_DIR" >&2
        printf '%sThen reload your shell, or invoke directly:%s %s/%s version\n' \
            "$DIM" "$RESET" "$INSTALL_DIR" "$BIN_NAME" >&2
        ;;
esac

cat <<EOF >&2

${BOLD}Next steps${RESET}
  - Write a sidecar config:  https://github.com/${REPO}/blob/main/INSTALLATION.md#step-6-write-the-sidecar-yaml
  - Run it:                  ${BIN_NAME} --config sidecar.yaml
  - Self-update later with:  ${BIN_NAME} update

EOF
