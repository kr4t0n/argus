package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	ID           string         `yaml:"id"`
	Type         string         `yaml:"type"`
	Machine      string         `yaml:"machine"`
	Capabilities []string       `yaml:"capabilities"`
	Version      string         `yaml:"version"`
	// WorkingDir is the directory the wrapped CLI subprocess runs in.
	// Supports ~ expansion and ${ENV} substitution. If empty, the CLI
	// inherits the sidecar's own working directory.
	WorkingDir   string         `yaml:"workingDir"`
	Bus          BusConfig      `yaml:"bus"`
	Adapter      map[string]any `yaml:"adapter"`
}

type BusConfig struct {
	URL string `yaml:"url"`
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
	if cfg.Version == "" {
		cfg.Version = "0.1.0"
	}
	if cfg.Capabilities == nil {
		cfg.Capabilities = []string{}
	}

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
	return &cfg, nil
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
