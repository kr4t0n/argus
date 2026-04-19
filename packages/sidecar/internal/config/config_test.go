package config

import (
	"os"
	"path/filepath"
	"testing"
)

// writeYAML drops a config blob into a temp file and returns the path.
// Each test gets its own tempdir so we never have to clean up by hand.
func writeYAML(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "sidecar.yaml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatalf("write yaml: %v", err)
	}
	return p
}

// TestLoad_MachineAutoDetect_FromHostname is the headline assertion for
// this commit: a YAML with no `machine:` field must still load, and
// must populate cfg.Machine with the host's name (after the .local
// strip). We compare against os.Hostname() rather than a literal so the
// test is stable across whatever box CI runs on.
func TestLoad_MachineAutoDetect_FromHostname(t *testing.T) {
	cfg, err := Load(writeYAML(t, `
id: claude-1
type: claude-code
bus:
  url: redis://localhost:6379
adapter:
  binary: claude
`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := detectMachine()
	if cfg.Machine != want {
		t.Fatalf("Machine = %q, want %q (auto-detected)", cfg.Machine, want)
	}
	if cfg.Machine == "" {
		t.Fatalf("auto-detected machine is empty — registration would emit a blank column")
	}
}

// TestLoad_MachineExplicitOverride: when the YAML pins `machine:`, we
// must keep that value verbatim and skip auto-detection. Lots of users
// (and the deploy/sidecar.example.yaml fallback) rely on being able to
// label two sidecars on the same host distinctly.
func TestLoad_MachineExplicitOverride(t *testing.T) {
	cfg, err := Load(writeYAML(t, `
id: claude-1
type: claude-code
machine: prod-runner-7
bus:
  url: redis://localhost:6379
adapter:
  binary: claude
`))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Machine != "prod-runner-7" {
		t.Fatalf("Machine = %q, want %q (explicit YAML must win over hostname)", cfg.Machine, "prod-runner-7")
	}
}

// TestDetectMachine_StripsLocalSuffix covers the macOS Bonjour /
// avahi `.local` mDNS suffix. We can't easily mock os.Hostname() here
// without dependency injection, so we just exercise the trimmer
// directly via a table.
func TestDetectMachine_StripsLocalSuffix(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"kyles-Mac-mini.local", "kyles-Mac-mini"},
		{"plain", "plain"},
		{"  spacey  ", "spacey"},
		{"", "unknown"},
		{".local", "unknown"},                                          // suffix-only collapses
		{"ip-10-0-1-23.ec2.internal", "ip-10-0-1-23.ec2.internal"},     // FQDN preserved on purpose
		{"worker.local.example.com", "worker.local.example.com"},       // .local only stripped at suffix
	}
	for _, c := range cases {
		got := normalizeHostname(c.in)
		if got != c.want {
			t.Errorf("normalizeHostname(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
