package machine

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sidecar.json")

	in := &Cache{
		MachineID: "00000000-0000-0000-0000-000000000001",
		Name:      "kyles-Mac-mini",
		Bus:       "redis://localhost:6379",
		Server:    ServerConfig{URL: "http://localhost:4000", Token: "tok"},
		Agents: []AgentRecord{{
			AgentID:          "a1",
			Name:             "claude-1",
			Type:             "claude-code",
			WorkingDir:       "/tmp/x",
			SupportsTerminal: true,
			Adapter:          map[string]any{"binary": "claude"},
		}},
	}
	if err := Save(path, in); err != nil {
		t.Fatalf("save: %v", err)
	}

	out, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if out.SchemaVersion != CacheSchemaVersion {
		t.Errorf("schemaVersion = %d, want %d", out.SchemaVersion, CacheSchemaVersion)
	}
	if out.MachineID != in.MachineID || out.Name != in.Name || out.Bus != in.Bus {
		t.Errorf("identity not round-tripped: got %+v", out)
	}
	if len(out.Agents) != 1 || out.Agents[0].AgentID != "a1" {
		t.Errorf("agents not round-tripped: %+v", out.Agents)
	}
}

func TestSaveAtomicTempCleanup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sidecar.json")
	if err := Save(path, &Cache{MachineID: "x", Bus: "redis://x"}); err != nil {
		t.Fatalf("save: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if e.Name() != "sidecar.json" {
			t.Errorf("stray file left behind: %s", e.Name())
		}
	}
}

func TestLoadMissingMachineIDIsError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sidecar.json")
	body, _ := json.Marshal(map[string]any{"schemaVersion": 1, "bus": "redis://x"})
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected error on missing machineId")
	}
}

func TestLoadNewerSchemaRejected(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sidecar.json")
	body, _ := json.Marshal(map[string]any{
		"schemaVersion": CacheSchemaVersion + 5,
		"machineId":     "x",
		"bus":           "redis://x",
	})
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected error on newer schema")
	}
}

func TestNormalizeHostname(t *testing.T) {
	cases := []struct{ in, out string }{
		{"kyles-Mac-mini.local", "kyles-Mac-mini"},
		{" kyles-Mac-mini.local ", "kyles-Mac-mini"},
		{"merlin", "merlin"},
		{"ip-10-0-1-23.ec2.internal", "ip-10-0-1-23.ec2.internal"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := normalizeHostname(tc.in); got != tc.out {
			t.Errorf("normalizeHostname(%q) = %q, want %q", tc.in, got, tc.out)
		}
	}
}

func TestDefaultPathRespectsArgusConfigDir(t *testing.T) {
	t.Setenv("ARGUS_CONFIG_DIR", "/opt/argus")
	t.Setenv("XDG_CONFIG_HOME", "/should/be/ignored")
	got, err := DefaultPath()
	if err != nil {
		t.Fatalf("DefaultPath: %v", err)
	}
	want := "/opt/argus/sidecar.json"
	if got != want {
		t.Errorf("DefaultPath = %q, want %q", got, want)
	}
}
