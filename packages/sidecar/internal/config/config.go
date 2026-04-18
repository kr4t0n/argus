package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	ID      string `yaml:"id"`
	Type    string `yaml:"type"`
	Machine string `yaml:"machine"`
	Version string `yaml:"version"`
	// WorkingDir is the directory the wrapped CLI subprocess runs in.
	// Supports ~ expansion and ${ENV} substitution. If empty, the CLI
	// inherits the sidecar's own working directory.
	WorkingDir string         `yaml:"workingDir"`
	Bus        BusConfig      `yaml:"bus"`
	Server     ServerConfig   `yaml:"server"`
	Adapter    map[string]any `yaml:"adapter"`
	Terminal   TerminalConfig `yaml:"terminal"`
}

type BusConfig struct {
	URL string `yaml:"url"`
}

// ServerConfig configures the direct sidecar↔server WebSocket link.
// Required when terminal.enabled is true (terminal traffic does not
// flow over Redis — see packages/shared-types/src/protocol.ts).
type ServerConfig struct {
	// URL is the server base, e.g. "http://localhost:4000". The
	// sidecar appends /sidecar-link and upgrades to ws.
	URL string `yaml:"url"`
	// Token is matched against the server's SIDECAR_LINK_TOKEN env
	// var. If the server has no token set, any value (or empty) is
	// accepted — useful for local dev.
	Token string `yaml:"token"`
}

// TerminalConfig opts a sidecar into serving interactive PTY sessions.
// Defaults: disabled. When enabled the dashboard can open terminals on
// this machine running as the sidecar's UID — treat as you would SSH
// access and only enable it on hosts where dashboard users are trusted
// to that level.
type TerminalConfig struct {
	Enabled bool `yaml:"enabled"`
	// Shells is the allowlist of shell binaries the sidecar will spawn.
	// Empty defaults to ["/bin/zsh", "/bin/bash", "/bin/sh"].
	Shells []string `yaml:"shells"`
	// DefaultShell is used when the dashboard doesn't specify one.
	// Empty falls back to $SHELL, then to the first entry of Shells.
	DefaultShell string `yaml:"defaultShell"`
	// MaxSessions caps concurrent open terminals per sidecar (default 5).
	MaxSessions int `yaml:"maxSessions"`
	// Cwd overrides the default working dir for new terminals.
	// Empty inherits Config.WorkingDir, then the sidecar's own cwd.
	Cwd string `yaml:"cwd"`
}

func Load(path string) (*Config, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve path: %w", err)
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var cfg Config
	if err := yaml.Unmarshal(b, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if cfg.ID == "" {
		return nil, fmt.Errorf("config.id is required")
	}
	if cfg.Type == "" {
		return nil, fmt.Errorf("config.type is required")
	}
	if cfg.Machine == "" {
		if hn, err := os.Hostname(); err == nil {
			cfg.Machine = hn
		} else {
			cfg.Machine = "unknown"
		}
	}
	if cfg.Bus.URL == "" {
		cfg.Bus.URL = "redis://localhost:6379"
	}
	// cfg.Version intentionally has no default. Empty means "let the
	// adapter detect the wrapped CLI's version at register time"; set
	// it explicitly in YAML only if auto-detection is wrong or the
	// wrapped CLI doesn't support `--version`.

	if cfg.WorkingDir != "" {
		resolved, err := expandPath(cfg.WorkingDir)
		if err != nil {
			return nil, fmt.Errorf("workingDir: %w", err)
		}
		info, err := os.Stat(resolved)
		if err != nil {
			return nil, fmt.Errorf("workingDir %q: %w", resolved, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("workingDir %q is not a directory", resolved)
		}
		cfg.WorkingDir = resolved
	}

	if cfg.Terminal.Enabled && cfg.Server.URL == "" {
		return nil, fmt.Errorf("terminal.enabled requires server.url (terminal traffic uses the direct sidecar link, not Redis)")
	}

	if cfg.Terminal.Enabled {
		if len(cfg.Terminal.Shells) == 0 {
			cfg.Terminal.Shells = []string{"/bin/zsh", "/bin/bash", "/bin/sh"}
		}
		if cfg.Terminal.MaxSessions <= 0 {
			cfg.Terminal.MaxSessions = 5
		}
		if cfg.Terminal.DefaultShell == "" {
			if env := os.Getenv("SHELL"); env != "" && containsString(cfg.Terminal.Shells, env) {
				cfg.Terminal.DefaultShell = env
			} else {
				cfg.Terminal.DefaultShell = cfg.Terminal.Shells[0]
			}
		}
		if !containsString(cfg.Terminal.Shells, cfg.Terminal.DefaultShell) {
			return nil, fmt.Errorf("terminal.defaultShell %q must appear in terminal.shells", cfg.Terminal.DefaultShell)
		}
		if cfg.Terminal.Cwd != "" {
			resolved, err := expandPath(cfg.Terminal.Cwd)
			if err != nil {
				return nil, fmt.Errorf("terminal.cwd: %w", err)
			}
			cfg.Terminal.Cwd = resolved
		}
	}
	return &cfg, nil
}

func containsString(xs []string, target string) bool {
	for _, x := range xs {
		if x == target {
			return true
		}
	}
	return false
}

// expandPath resolves ~, ${VAR}, and relative paths against the current working dir.
func expandPath(p string) (string, error) {
	p = os.ExpandEnv(p)
	if strings.HasPrefix(p, "~") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		p = filepath.Join(home, strings.TrimPrefix(p, "~"))
	}
	return filepath.Abs(p)
}
