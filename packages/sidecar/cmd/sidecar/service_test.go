package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestRenderSystemdUnitUserScope locks in the two properties a
// hand-written user unit most often gets wrong: the [Install] target
// (default.target, not multi-user.target — the latter never starts at
// login in the user manager) and an explicit PATH, without which
// adapter discovery finds none of the agent CLIs installed under $HOME.
func TestRenderSystemdUnitUserScope(t *testing.T) {
	unit := renderSystemdUnit(serviceConfig{
		ExePath: "/usr/local/bin/argus-sidecar",
		PATH:    "/home/kyle/.local/bin:/usr/bin:/bin",
	})

	want := []string{
		"ExecStart=/usr/local/bin/argus-sidecar run",
		`Environment="PATH=/home/kyle/.local/bin:/usr/bin:/bin"`,
		"WantedBy=default.target",
		"Restart=on-failure",
	}
	for _, s := range want {
		if !strings.Contains(unit, s) {
			t.Errorf("user unit missing %q\n%s", s, unit)
		}
	}
	if strings.Contains(unit, "WantedBy=multi-user.target") {
		t.Errorf("user unit must not use multi-user.target\n%s", unit)
	}
	// A user unit is owned by the account that installed it; a User=
	// line there is rejected by the user manager.
	if strings.Contains(unit, "User=") {
		t.Errorf("user unit must not carry a User= line\n%s", unit)
	}
}

func TestRenderSystemdUnitSystemScope(t *testing.T) {
	unit := renderSystemdUnit(serviceConfig{
		ExePath: "/usr/local/bin/argus-sidecar",
		Account: "argus",
		PATH:    "/usr/bin:/bin",
		System:  true,
	})

	if !strings.Contains(unit, "User=argus") {
		t.Errorf("system unit missing User=argus\n%s", unit)
	}
	if !strings.Contains(unit, "WantedBy=multi-user.target") {
		t.Errorf("system unit missing multi-user.target\n%s", unit)
	}
	if strings.Contains(unit, "WantedBy=default.target") {
		t.Errorf("system unit must not use default.target\n%s", unit)
	}
}

// TestExecStartCachePassthrough proves the -cache override reaches the
// unit, and that a path with a space is quoted rather than silently
// split into two argv entries by systemd's parser.
func TestExecStartCachePassthrough(t *testing.T) {
	unit := renderSystemdUnit(serviceConfig{
		ExePath:   "/usr/local/bin/argus-sidecar",
		CachePath: "/srv/argus state/sidecar.json",
	})
	want := `ExecStart=/usr/local/bin/argus-sidecar run -cache "/srv/argus state/sidecar.json"`
	if !strings.Contains(unit, want) {
		t.Errorf("ExecStart not quoted as expected: want %q\n%s", want, unit)
	}

	// Without an override we emit no -cache at all, so the daemon
	// resolves XDG itself and the unit stays host-agnostic.
	plain := renderSystemdUnit(serviceConfig{ExePath: "/usr/local/bin/argus-sidecar"})
	if strings.Contains(plain, "-cache") {
		t.Errorf("default install should not pin a cache path\n%s", plain)
	}
}

func TestSystemdUnitPathHonoursXDG(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/tmp/xdg-config")
	got, err := systemdUnitPath(false)
	if err != nil {
		t.Fatalf("systemdUnitPath: %v", err)
	}
	want := filepath.Join("/tmp/xdg-config", "systemd", "user", systemdUnitName)
	if got != want {
		t.Errorf("systemdUnitPath(user) = %q, want %q", got, want)
	}

	sys, err := systemdUnitPath(true)
	if err != nil {
		t.Fatalf("systemdUnitPath(system): %v", err)
	}
	if want := filepath.Join("/etc/systemd/system", systemdUnitName); sys != want {
		t.Errorf("systemdUnitPath(system) = %q, want %q", sys, want)
	}
}

func TestRenderLaunchdPlist(t *testing.T) {
	plist := renderLaunchdPlist(serviceConfig{
		ExePath:   "/usr/local/bin/argus-sidecar",
		CachePath: "/Users/kyle/.config/argus/sidecar.json",
		PATH:      "/opt/homebrew/bin:/usr/bin",
		LogDir:    "/Users/kyle/Library/Logs",
	})

	want := []string{
		"<key>Label</key><string>com.argus.sidecar</string>",
		"<string>/usr/local/bin/argus-sidecar</string>",
		"<string>run</string>",
		"<string>-cache</string>",
		"<string>/Users/kyle/.config/argus/sidecar.json</string>",
		"<string>/Users/kyle/Library/Logs/argus-sidecar.err.log</string>",
		"<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>",
	}
	for _, s := range want {
		if !strings.Contains(plist, s) {
			t.Errorf("plist missing %q\n%s", s, plist)
		}
	}
}

// TestPlistEscape guards the XML injection path: a directory name is
// user-controlled and `&` in a path would otherwise produce a plist
// launchd refuses to parse.
func TestPlistEscape(t *testing.T) {
	plist := renderLaunchdPlist(serviceConfig{
		ExePath: "/Users/kyle/bin & tools/argus-sidecar",
		LogDir:  "/tmp",
	})
	if !strings.Contains(plist, "/Users/kyle/bin &amp; tools/argus-sidecar") {
		t.Errorf("plist did not escape &\n%s", plist)
	}
	if strings.Contains(plist, "bin & tools") {
		t.Errorf("plist leaked a raw &\n%s", plist)
	}
}

// skipIfSystemUnitInstalled keeps the restart-plan tests honest on a
// host that actually runs the sidecar: the system unit path is hardcoded
// (/etc/systemd/system), so unlike the user scope it cannot be redirected
// into a temp dir.
func skipIfSystemUnitInstalled(t *testing.T) {
	t.Helper()
	if _, err := os.Stat(filepath.Join("/etc/systemd/system", systemdUnitName)); err == nil {
		t.Skip("a system-wide unit is installed here; detection is not hermetic")
	}
}

func TestDetectRestartPlanNothingRunning(t *testing.T) {
	skipIfSystemUnitInstalled(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir()) // no user unit
	t.Setenv("ARGUS_STATE_DIR", t.TempDir()) // no pidfile

	if plan := detectRestartPlan(); plan.Kind != "" {
		t.Errorf("Kind = %q, want empty when nothing is running", plan.Kind)
	}
}

// TestDetectRestartPlanDaemon covers the fallback branch: no service
// unit, but a live process named by the pidfile. Our own PID stands in
// for the daemon, since it is guaranteed alive.
func TestDetectRestartPlanDaemon(t *testing.T) {
	skipIfSystemUnitInstalled(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	state := t.TempDir()
	t.Setenv("ARGUS_STATE_DIR", state)
	if err := os.WriteFile(filepath.Join(state, "sidecar.pid"), []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		t.Fatalf("write pidfile: %v", err)
	}

	plan := detectRestartPlan()
	if plan.Kind != restartViaDaemon {
		t.Fatalf("Kind = %q, want %q", plan.Kind, restartViaDaemon)
	}
	if plan.Command != "argus-sidecar restart" {
		t.Errorf("Command = %q, want `argus-sidecar restart`", plan.Command)
	}
}

// TestDetectRestartPlanStalePidfile guards the case that would otherwise
// prompt for a restart of nothing: a pidfile left behind by a daemon
// that died without cleaning up.
func TestDetectRestartPlanStalePidfile(t *testing.T) {
	skipIfSystemUnitInstalled(t)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	state := t.TempDir()
	t.Setenv("ARGUS_STATE_DIR", state)
	// PID 0 is never a live user process, and ProcessAlive must reject
	// it rather than treating the pidfile's mere existence as proof.
	if err := os.WriteFile(filepath.Join(state, "sidecar.pid"), []byte("0"), 0o644); err != nil {
		t.Fatalf("write pidfile: %v", err)
	}

	if plan := detectRestartPlan(); plan.Kind != "" {
		t.Errorf("Kind = %q, want empty for a stale pidfile", plan.Kind)
	}
}

func TestSystemctlArgs(t *testing.T) {
	if got := systemctlArgs(false, "daemon-reload"); got[0] != "--user" {
		t.Errorf("user scope must pass --user, got %v", got)
	}
	if got := systemctlArgs(true, "daemon-reload"); got[0] != "daemon-reload" {
		t.Errorf("system scope must not pass --user, got %v", got)
	}
}
