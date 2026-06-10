# Argus sidecar build targets.
#
# Default target builds native binaries for whatever host you're on.
# The `linux-*` / `darwin-*` targets cross-compile static binaries
# suitable for copying onto a remote machine (no cgo deps).
#
# Two binaries are produced:
#   - argus-sidecar  the per-machine daemon
#   - argus-bg       the wrapper agents invoke from a shell to expose a
#                    backgrounded command's tqdm progress to the dashboard
#                    (shipped alongside the sidecar; the sidecar prepends
#                    its bin dir to PATH for shells it spawns)
#
# Usage:
#   make                   # host build → bin/argus-sidecar + bin/argus-bg
#   make linux-amd64       # → bin/argus-{sidecar,bg}-linux-amd64
#   make linux-arm64       # → bin/argus-{sidecar,bg}-linux-arm64
#   make cross             # all supported GOOS/GOARCH targets
#   make clean             # wipe ./bin

SIDECAR_PKG := ./cmd/sidecar
BG_PKG      := ./cmd/argus-bg
BIN_DIR     := bin
SIDECAR_BIN := argus-sidecar
BG_BIN      := argus-bg

# Version baked into the binary via -ldflags. The `update` subcommand uses
# this for the "already on latest" check. Override on the command line:
#   make build VERSION=argus-sidecar-v0.1.0
# The release workflow always sets this to the git tag name.
VERSION   ?= dev

# -s -w: strip debug symbols & DWARF (smaller binary).
# -trimpath: drop absolute paths from the binary for reproducibility.
# -X main.Version: bake the version string into the binary.
GOFLAGS   := -trimpath -ldflags="-s -w -X main.Version=$(VERSION)"

# CGO off → fully static; creack/pty uses pure-Go syscalls so this works on
# every target we care about (linux/darwin × amd64/arm64).
CGO_ENABLED ?= 0

.PHONY: all build clean cross test \
        linux-amd64 linux-arm64 darwin-amd64 darwin-arm64

all: build

build:
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=$(CGO_ENABLED) go build $(GOFLAGS) -o $(BIN_DIR)/$(SIDECAR_BIN) $(SIDECAR_PKG)
	CGO_ENABLED=$(CGO_ENABLED) go build $(GOFLAGS) -o $(BIN_DIR)/$(BG_BIN) $(BG_PKG)
	@echo "built $(BIN_DIR)/$(SIDECAR_BIN) + $(BIN_DIR)/$(BG_BIN) for $$(go env GOOS)/$$(go env GOARCH)"

test:
	go test ./...

linux-amd64:
	@mkdir -p $(BIN_DIR)
	GOOS=linux GOARCH=amd64 CGO_ENABLED=$(CGO_ENABLED) \
		go build $(GOFLAGS) -o $(BIN_DIR)/$(SIDECAR_BIN)-linux-amd64 $(SIDECAR_PKG)
	GOOS=linux GOARCH=amd64 CGO_ENABLED=$(CGO_ENABLED) \
		go build $(GOFLAGS) -o $(BIN_DIR)/$(BG_BIN)-linux-amd64 $(BG_PKG)
	@echo "built $(BIN_DIR)/{$(SIDECAR_BIN),$(BG_BIN)}-linux-amd64"

linux-arm64:
	@mkdir -p $(BIN_DIR)
	GOOS=linux GOARCH=arm64 CGO_ENABLED=$(CGO_ENABLED) \
		go build $(GOFLAGS) -o $(BIN_DIR)/$(SIDECAR_BIN)-linux-arm64 $(SIDECAR_PKG)
	GOOS=linux GOARCH=arm64 CGO_ENABLED=$(CGO_ENABLED) \
		go build $(GOFLAGS) -o $(BIN_DIR)/$(BG_BIN)-linux-arm64 $(BG_PKG)
	@echo "built $(BIN_DIR)/{$(SIDECAR_BIN),$(BG_BIN)}-linux-arm64"

darwin-amd64:
	@mkdir -p $(BIN_DIR)
	GOOS=darwin GOARCH=amd64 CGO_ENABLED=$(CGO_ENABLED) \
		go build $(GOFLAGS) -o $(BIN_DIR)/$(SIDECAR_BIN)-darwin-amd64 $(SIDECAR_PKG)
	GOOS=darwin GOARCH=amd64 CGO_ENABLED=$(CGO_ENABLED) \
		go build $(GOFLAGS) -o $(BIN_DIR)/$(BG_BIN)-darwin-amd64 $(BG_PKG)
	@echo "built $(BIN_DIR)/{$(SIDECAR_BIN),$(BG_BIN)}-darwin-amd64"

darwin-arm64:
	@mkdir -p $(BIN_DIR)
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=$(CGO_ENABLED) \
		go build $(GOFLAGS) -o $(BIN_DIR)/$(SIDECAR_BIN)-darwin-arm64 $(SIDECAR_PKG)
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=$(CGO_ENABLED) \
		go build $(GOFLAGS) -o $(BIN_DIR)/$(BG_BIN)-darwin-arm64 $(BG_PKG)
	@echo "built $(BIN_DIR)/{$(SIDECAR_BIN),$(BG_BIN)}-darwin-arm64"

cross: linux-amd64 linux-arm64 darwin-amd64 darwin-arm64

clean:
	rm -rf $(BIN_DIR)
