// Command argus-bg wraps a long-running command, captures its output
// through a PTY, parses tqdm-style progress frames, and writes a
// structured JSONL event stream into
//
//	<workingDir>/.argus/progress/<taskId>.jsonl
//
// so the Argus sidecar (and the dashboard's per-project Progress tab)
// can render live progress for detached background work that would
// otherwise be invisible — once a process backgrounds itself with `&`
// or `nohup`, its output no longer flows through the agent's PTY.
//
// Usage:
//
//	argus-bg [flags] -- <command> [args...]
//
// Flags:
//
//	-id <id>           task id (default: random uuid)
//	-label <text>      human-friendly label shown in the dashboard
//	-tee <log-path>    also write raw output to this log file
//
// Everything after `--` is the wrapped command, verbatim. The wrapped
// command runs in its own PTY so tqdm keeps its interactive rendering
// (tqdm disables the bar entirely when stdout is a pipe). argus-bg
// forwards every child byte to its own stdout so the user still sees
// the progress bar in their terminal; tqdm frames are parsed off the
// stream and emitted as JSONL progress events, throttled to at most one
// per 500ms OR whenever the integer percent ticks.
//
// On child exit (including SIGINT / SIGTERM forwarded by the user),
// argus-bg writes a final "end" event and exits with the child's exit
// code so shell pipelines continue to behave as expected.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/google/uuid"
	"golang.org/x/term"
)

// Version is injected at build time via -ldflags="-X main.Version=…", the
// same flag the Makefile already passes to the sidecar build. Untagged dev
// builds report "dev"; release builds report the git tag (e.g.
// "argus-sidecar-v0.1.0") so `argus-bg version` makes companion drift
// observable next to `argus-sidecar version`.
var Version = "dev"

// progressThrottle is the minimum wall-clock gap between two emitted
// progress events for the same task. The other gate is "integer percent
// changed"; whichever fires first wins. Picked to bound the JSONL file
// growth on a typical tqdm bar (~10 frames/sec) without making the UI
// look sluggish.
const progressThrottle = 500 * time.Millisecond

func main() {
	fs := flag.NewFlagSet("argus-bg", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, `argus-bg — wrap a command, parse tqdm, write JSONL progress

Usage:
  argus-bg [flags] -- <command> [args...]
  argus-bg version

Flags:
  -id <id>           task id (default: random uuid)
  -label <text>      human-friendly label shown in the dashboard
  -tee <log-path>    also write raw output to this log file

The wrapped command runs in its own PTY so tqdm's interactive rendering
stays enabled. The JSONL stream lands in $ARGUS_PROGRESS_DIR, or
<cwd>/.argus/progress/ when the env var isn't set.
`)
	}
	id := fs.String("id", "", "task id (default: random uuid)")
	label := fs.String("label", "", "human-friendly label")
	teePath := fs.String("tee", "", "tee raw output to this log file")

	argv := os.Args[1:]

	// Everything after the first `--` is the wrapped command, verbatim — its
	// own flags must not be mistaken for ours. So locate the separator first
	// and only scan the flags region (before `--`) for our -h/--help/version
	// tokens. (Scanning all of argv would misfire on e.g.
	// `argus-bg -- mytool --version`.)
	sep := -1
	for i, a := range argv {
		if a == "--" {
			sep = i
			break
		}
	}
	flagsEnd := len(argv)
	if sep >= 0 {
		flagsEnd = sep
	}
	for _, a := range argv[:flagsEnd] {
		switch a {
		case "-h", "--help":
			fs.Usage()
			os.Exit(0)
		case "version", "--version", "-v":
			fmt.Printf("argus-bg %s %s/%s\n", Version, runtime.GOOS, runtime.GOARCH)
			os.Exit(0)
		}
	}

	if sep < 0 {
		fs.Usage()
		fmt.Fprintln(os.Stderr, "\nerror: missing `--` separator before command")
		os.Exit(2)
	}
	if err := fs.Parse(argv[:sep]); err != nil {
		os.Exit(2)
	}
	childArgv := argv[sep+1:]
	if len(childArgv) == 0 {
		fs.Usage()
		fmt.Fprintln(os.Stderr, "\nerror: no command after `--`")
		os.Exit(2)
	}

	taskID := strings.TrimSpace(*id)
	if taskID == "" {
		taskID = uuid.NewString()
	}
	taskLabel := strings.TrimSpace(*label)
	if taskLabel == "" {
		taskLabel = filepath.Base(childArgv[0])
	}

	progressDir, err := resolveProgressDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "argus-bg: %v\n", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(progressDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "argus-bg: mkdir progress dir: %v\n", err)
		os.Exit(1)
	}
	jsonlPath := filepath.Join(progressDir, taskID+".jsonl")
	jf, err := os.OpenFile(jsonlPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "argus-bg: open jsonl: %v\n", err)
		os.Exit(1)
	}
	defer jf.Close()
	writer := &eventWriter{f: jf}

	var teeFile *os.File
	if *teePath != "" {
		teeFile, err = os.OpenFile(*teePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			fmt.Fprintf(os.Stderr, "argus-bg: open tee: %v\n", err)
			os.Exit(1)
		}
		defer teeFile.Close()
	}

	cwd, _ := os.Getwd()

	cmd := exec.Command(childArgv[0], childArgv[1:]...)
	cmd.Env = os.Environ()
	cmd.Dir = cwd

	// Initial PTY size: copy from our controlling terminal if we have
	// one, otherwise a sensible default. SIGWINCH propagation below
	// keeps it in sync after the user resizes.
	cols, rows := 120, 32
	if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil && w > 0 && h > 0 {
		cols, rows = w, h
	}

	childPty, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		writer.writeEnd(taskID, 127, "failed")
		fmt.Fprintf(os.Stderr, "argus-bg: pty start: %v\n", err)
		os.Exit(127)
	}
	defer childPty.Close()

	writer.writeStart(taskID, taskLabel, childArgv, cwd, cmd.Process.Pid)
	writer.sync()

	// Forward user-facing signals to the wrapped child, and reflect
	// terminal resize so tqdm redraws at the right width.
	sigs := make(chan os.Signal, 4)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGWINCH)
	go func() {
		for s := range sigs {
			if s == syscall.SIGWINCH {
				if w, h, err := term.GetSize(int(os.Stdout.Fd())); err == nil && w > 0 && h > 0 {
					_ = pty.Setsize(childPty, &pty.Winsize{Cols: uint16(w), Rows: uint16(h)})
				}
				continue
			}
			if cmd.Process != nil {
				_ = cmd.Process.Signal(s)
			}
		}
	}()

	pump(childPty, os.Stdout, teeFile, taskID, writer)

	werr := cmd.Wait()
	exitCode := 0
	status := "done"
	if werr != nil {
		var ee *exec.ExitError
		if errors.As(werr, &ee) {
			exitCode = ee.ExitCode()
		} else {
			exitCode = 1
		}
		status = "failed"
	}
	writer.writeEnd(taskID, exitCode, status)
	writer.sync()
	os.Exit(exitCode)
}

// resolveProgressDir picks the directory the JSONL file is written to.
//
// $ARGUS_PROGRESS_DIR takes priority — the sidecar exports it on every
// shell it spawns, pointing at <workingDir>/.argus/progress. Without
// the env var (e.g. when argus-bg is invoked from a shell not started
// by the sidecar), walk up from cwd looking for an existing .argus/
// directory; if none is found, default to <cwd>/.argus/progress so the
// file at least lands somewhere predictable.
func resolveProgressDir() (string, error) {
	if v := os.Getenv("ARGUS_PROGRESS_DIR"); v != "" {
		return v, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("getcwd: %w", err)
	}
	dir := cwd
	for {
		if st, err := os.Stat(filepath.Join(dir, ".argus")); err == nil && st.IsDir() {
			return filepath.Join(dir, ".argus", "progress"), nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return filepath.Join(cwd, ".argus", "progress"), nil
}

// eventWriter serializes JSONL writes behind a mutex. A single goroutine
// drives writes in practice (the pump + the start/end emitters in main
// run sequentially), but the lock is cheap insurance against future
// refactors that might split them.
type eventWriter struct {
	mu sync.Mutex
	f  *os.File
}

type startEvent struct {
	Type      string   `json:"type"` // "start"
	ID        string   `json:"id"`
	Label     string   `json:"label,omitempty"`
	Cmd       []string `json:"cmd,omitempty"`
	Cwd       string   `json:"cwd,omitempty"`
	PID       int      `json:"pid,omitempty"`
	StartedAt int64    `json:"startedAt"`
	TS        int64    `json:"ts"`
}

type progressEvent struct {
	Type       string  `json:"type"` // "progress"
	ID         string  `json:"id"`
	Current    int64   `json:"current"`
	Total      int64   `json:"total,omitempty"`
	Percent    float64 `json:"percent"`
	EtaSeconds float64 `json:"etaSeconds,omitempty"`
	Rate       float64 `json:"rate,omitempty"`
	Unit       string  `json:"unit,omitempty"`
	Desc       string  `json:"desc,omitempty"`
	TS         int64   `json:"ts"`
}

type endEvent struct {
	Type     string `json:"type"` // "end"
	ID       string `json:"id"`
	ExitCode int    `json:"exitCode"`
	Status   string `json:"status"` // "done" | "failed"
	EndedAt  int64  `json:"endedAt"`
	TS       int64  `json:"ts"`
}

func (w *eventWriter) writeStart(id, label string, cmd []string, cwd string, pid int) {
	now := time.Now().UnixMilli()
	w.writeJSON(startEvent{
		Type:      "start",
		ID:        id,
		Label:     label,
		Cmd:       cmd,
		Cwd:       cwd,
		PID:       pid,
		StartedAt: now,
		TS:        now,
	})
}

func (w *eventWriter) writeProgress(id string, f tqdmFrame) {
	w.writeJSON(progressEvent{
		Type:       "progress",
		ID:         id,
		Current:    f.Current,
		Total:      f.Total,
		Percent:    f.Percent,
		EtaSeconds: f.EtaSeconds,
		Rate:       f.Rate,
		Unit:       f.Unit,
		Desc:       f.Desc,
		TS:         time.Now().UnixMilli(),
	})
}

func (w *eventWriter) writeEnd(id string, exitCode int, status string) {
	now := time.Now().UnixMilli()
	w.writeJSON(endEvent{
		Type:     "end",
		ID:       id,
		ExitCode: exitCode,
		Status:   status,
		EndedAt:  now,
		TS:       now,
	})
}

func (w *eventWriter) writeJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	b = append(b, '\n')
	w.mu.Lock()
	defer w.mu.Unlock()
	_, _ = w.f.Write(b)
}

func (w *eventWriter) sync() {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.f.Sync()
}

// pump forwards every byte from the child PTY to argus-bg's stdout (so
// the user still sees the bar) and the optional --tee file (so existing
// log workflows keep working), while splitting the byte stream into
// "lines" delimited by either \n OR \r — tqdm overwrites in place with
// a leading \r, so each new frame ends one virtual line. Throttling
// keeps the JSONL bounded even when tqdm fires 10+ frames/sec.
func pump(src io.Reader, dst io.Writer, tee io.Writer, taskID string, writer *eventWriter) {
	buf := make([]byte, 32*1024)
	var lineBuf strings.Builder

	var (
		lastEmit    time.Time
		lastPercent = -1
	)
	maybeEmit := func(p tqdmFrame) {
		intPct := int(p.Percent + 0.5)
		if time.Since(lastEmit) < progressThrottle && intPct == lastPercent {
			return
		}
		lastEmit = time.Now()
		lastPercent = intPct
		writer.writeProgress(taskID, p)
	}
	flushLine := func() {
		line := lineBuf.String()
		lineBuf.Reset()
		if line == "" {
			return
		}
		if frame, ok := parseTqdm(line); ok {
			maybeEmit(frame)
		}
	}

	for {
		n, err := src.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			_, _ = dst.Write(chunk)
			if tee != nil {
				_, _ = tee.Write(chunk)
			}
			for _, b := range chunk {
				if b == '\n' || b == '\r' {
					flushLine()
					continue
				}
				lineBuf.WriteByte(b)
			}
		}
		if err != nil {
			flushLine()
			return
		}
	}
}
