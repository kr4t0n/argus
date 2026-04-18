package adapter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// marshal is a thin wrapper that returns a string and error, used by several
// adapters when building meta blobs or normalizing unknown content shapes.
func marshal(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// Match the first dotted-number run in a `--version` line, e.g.
// "claude 1.2.3 (anthropic-claude-code)" → "1.2.3".
var versionNumberRe = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?(?:[.\-+][\w.\-]*)?`)

// readBinaryVersion invokes `<binary> --version` with a short timeout and
// returns a cleaned-up version string. It prefers the first dotted-number
// run on the first non-empty line; if none is found it falls back to the
// raw first line. Returns an error only if the process fails to start or
// exits non-zero.
//
// Used by the claude-code / codex / cursor-cli adapters so the dashboard
// can auto-report the real CLI version instead of whatever the YAML said.
func readBinaryVersion(ctx context.Context, binary string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	var out bytes.Buffer
	cmd := exec.CommandContext(ctx, binary, "--version")
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%s --version: %w", binary, err)
	}
	for _, line := range strings.Split(out.String(), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if m := versionNumberRe.FindString(line); m != "" {
			return m, nil
		}
		// No dotted-number match — surface the raw line (e.g. "dev").
		return line, nil
	}
	return "", fmt.Errorf("%s --version: empty output", binary)
}
