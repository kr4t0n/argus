# Argus sidecar build targets.
#
# Default target builds a native binary for whatever host you're on.
# The `linux-*` / `darwin-*` targets cross-compile static binaries
# suitable for copying onto a remote machine (no cgo deps).
#
# Usage:
#   make                   # host build → bin/argus-sidecar
#   make linux-amd64       # → bin/argus-sidecar-linux-amd64
#   make linux-arm64       # → bin/argus-sidecar-linux-arm64
#   make cross             # all supported GOOS/GOARCH targets
#   make clean             # wipe ./bin

PKG       := ./cmd/sidecar
BIN_DIR   := bin
BIN_NAME  := argus-sidecar

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

.PHONY: all build clean cross \
        linux-amd64 linux-arm64 darwin-amd64 darwin-arm64

all: build

build:
	@mkdir -p $(BIN_DIR)
	CGO_ENABLED=$(CGO_ENABLED) go build $(GOFLAGS) -o $(BIN_DIR)/$(BIN_NAME) $(PKG)
	@echo "built $(BIN_DIR)/$(BIN_NAME) for $$(go env GOOS)/$$(go env GOARCH)"

linux-amd64:
	@mkdir -p $(BIN_DIR)
	GOOS=linux GOARCH=amd64 CGO_ENABLED=$(CGO_ENABLED) \
		go build $(GOFLAGS) -o $(BIN_DIR)/$(BIN_NAME)-linux-amd64 $(PKG)
	@echo "built $(BIN_DIR)/$(BIN_NAME)-linux-amd64"

linux-arm64:
	@mkdir -p $(BIN_DIR)
	GOOS=linux GOARCH=arm64 CGO_ENABLED=$(CGO_ENABLED) \
		go build $(GOFLAGS) -o $(BIN_DIR)/$(BIN_NAME)-linux-arm64 $(PKG)
	@echo "built $(BIN_DIR)/$(BIN_NAME)-linux-arm64"

darwin-amd64:
	@mkdir -p $(BIN_DIR)
	GOOS=darwin GOARCH=amd64 CGO_ENABLED=$(CGO_ENABLED) \
		go build $(GOFLAGS) -o $(BIN_DIR)/$(BIN_NAME)-darwin-amd64 $(PKG)
	@echo "built $(BIN_DIR)/$(BIN_NAME)-darwin-amd64"

darwin-arm64:
	@mkdir -p $(BIN_DIR)
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=$(CGO_ENABLED) \
		go build $(GOFLAGS) -o $(BIN_DIR)/$(BIN_NAME)-darwin-arm64 $(PKG)
	@echo "built $(BIN_DIR)/$(BIN_NAME)-darwin-arm64"

cross: linux-amd64 linux-arm64 darwin-amd64 darwin-arm64

clean:
	rm -rf $(BIN_DIR)
