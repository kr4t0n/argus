// Package terminal serves interactive PTY sessions on the agent's host
// machine. It consumes terminal control frames from the sidecar↔server
// WebSocket link, owns a PTY per session, and ships output back over
// the same link.
//
// Security model: terminal access is gated per-agent (Agent.supportsTerminal
// must be true; the dashboard sets this when the operator opts in at
// agent-creation time). The PTY inherits the sidecar daemon's UID, so
// anyone with dashboard access to a terminal-enabled agent effectively
// gets shell-as-sidecar-user on the agent's machine. Treat opting an
// agent into terminal access as equivalent to handing out SSH access
// to that user on that host.
package terminal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"

	"github.com/kyley/argus/sidecar/internal/protocol"
	"github.com/kyley/argus/sidecar/internal/sidecarlink"
)

const (
	// activeBurstInterval is how long we wait for more bytes once we're
	// already inside a burst. Tight value: local echo of a single
	// keystroke should still feel snappy even when adjacent bytes come
	// in back-to-back (shell redraws).
	activeBurstInterval = 4 * time.Millisecond
	// idleGap detects "first byte after quiet". If we've published
	// nothing for longer than this, the next arrival is almost
	// certainly a user keystroke; flush it immediately (no batching)
	// for minimum echo latency. Bytes arriving faster get the much
	// cheaper active-burst debounce.
	idleGap = 8 * time.Millisecond
	// outputBatchMax bounds a single output message. We cap well below
	// the server's frame limit (see MAX_FRAME_BYTES on the server) to
	// leave slack for JSON encoding overhead.
	outputBatchMax = 16 * 1024
)

// Link is the minimal surface of sidecarlink.Client that the runner
// needs. Kept as an interface to make testing painless.
type Link interface {
	Publish(frame any) bool
	Inbound() <-chan json.RawMessage
	IsConnected() bool
}

// AgentInfo is the per-agent slice of state the runner needs to validate
// terminal-open requests and pick a sensible default cwd. Provided by
// the daemon (which owns the AgentRecord set) via AgentLookup.
type AgentInfo struct {
	SupportsTerminal bool
	WorkingDir       string
}

// AgentLookup is the runner's read-only view onto the daemon's agent
// registry. Returns ok=false when the agent isn't known to this machine
// (e.g. a stale terminal-open after the agent was destroyed).
type AgentLookup interface {
	Lookup(agentID string) (AgentInfo, bool)
}

// Settings are the machine-wide PTY policy knobs. The dashboard never
// pokes at these — they're intentionally fixed to safe defaults at boot
// (DefaultSettings) with environment overrides for power users.
type Settings struct {
	// Shells is the allowlist of shell binaries the runner will spawn.
	Shells []string
	// DefaultShell is used when the dashboard doesn't specify one.
	// Must appear in Shells.
	DefaultShell string
	// MaxSessions caps concurrent open terminals across all agents on
	// this machine.
	MaxSessions int
}

// DefaultSettings returns the baseline policy a fresh sidecar boots with.
// Honors:
//   - $ARGUS_TERMINAL_SHELLS  : comma-separated allowlist override
//   - $ARGUS_TERMINAL_MAX     : MaxSessions override (positive int)
//   - $SHELL                  : preferred default shell, if in the allowlist
func DefaultSettings() Settings {
	shells := []string{"/bin/zsh", "/bin/bash", "/bin/sh"}
	if env := os.Getenv("ARGUS_TERMINAL_SHELLS"); env != "" {
		shells = splitCsv(env)
	}

	defaultShell := shells[0]
	if env := os.Getenv("SHELL"); env != "" && containsString(shells, env) {
		defaultShell = env
	}

	max := 5
	if env := os.Getenv("ARGUS_TERMINAL_MAX"); env != "" {
		var n int
		if _, err := fmt.Sscanf(env, "%d", &n); err == nil && n > 0 {
			max = n
		}
	}

	return Settings{
		Shells:       shells,
		DefaultShell: defaultShell,
		MaxSessions:  max,
	}
}

type Runner struct {
	settings Settings
	agents   AgentLookup
	link     Link
	log      *log.Logger

	mu       sync.Mutex
	sessions map[string]*ptySession
}

type ptySession struct {
	id      string
	cmd     *exec.Cmd
	pty     *os.File
	cancel  context.CancelFunc
	outSeq  int
	writeMu sync.Mutex
}

// New constructs a Runner. `link` is typically a *sidecarlink.Client
// but any Link implementation works.
func New(settings Settings, agents AgentLookup, link Link, logger *log.Logger) *Runner {
	return &Runner{
		settings: settings,
		agents:   agents,
		link:     link,
		log:      logger,
		sessions: make(map[string]*ptySession),
	}
}

// Run blocks until ctx is cancelled, dispatching inbound frames from
// the link to per-session handlers. If the link drops we don't do
// anything special from here — the server will have force-closed all
// of this sidecar's terminals on disconnect, and our pump/wait
// goroutines will observe their publishes returning false and exit.
func (r *Runner) Run(ctx context.Context) error {
	r.log.Printf("terminal: ready (max=%d shells=%v)", r.settings.MaxSessions, r.settings.Shells)
	for {
		select {
		case <-ctx.Done():
			r.killAll("sidecar shutdown")
			return nil
		case raw, ok := <-r.link.Inbound():
			if !ok {
				return nil
			}
			r.dispatch(ctx, raw)
		}
	}
}

func (r *Runner) dispatch(ctx context.Context, raw json.RawMessage) {
	var head struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		r.log.Printf("terminal: bad frame: %v", err)
		return
	}
	switch head.Kind {
	case protocol.TerminalKindOpen:
		var ev protocol.TerminalOpen
		if err := json.Unmarshal(raw, &ev); err != nil {
			r.log.Printf("terminal: bad open: %v", err)
			return
		}
		r.handleOpen(ctx, ev)
	case protocol.TerminalKindInput:
		var ev protocol.TerminalInput
		if err := json.Unmarshal(raw, &ev); err != nil {
			r.log.Printf("terminal: bad input: %v", err)
			return
		}
		r.handleInput(ev)
	case protocol.TerminalKindResize:
		var ev protocol.TerminalResize
		if err := json.Unmarshal(raw, &ev); err != nil {
			r.log.Printf("terminal: bad resize: %v", err)
			return
		}
		r.handleResize(ev)
	case protocol.TerminalKindCloseRequest:
		var ev protocol.TerminalCloseRequest
		if err := json.Unmarshal(raw, &ev); err != nil {
			r.log.Printf("terminal: bad close: %v", err)
			return
		}
		r.handleClose(ev.TerminalID, "closed by client")
	case protocol.LinkKindHello, protocol.LinkKindHelloAck:
		// Handshake frames are swallowed by the link client itself;
		// getting one here means someone rewired things. Ignore.
	default:
		r.log.Printf("terminal: unknown kind %q", head.Kind)
	}
}

func (r *Runner) handleOpen(parent context.Context, ev protocol.TerminalOpen) {
	if ev.TerminalID == "" {
		r.log.Printf("terminal: open missing terminalId")
		return
	}

	// Validate against the daemon's agent registry. Two failure modes:
	// the agent is gone (race with destroy), or the agent didn't opt
	// into terminal access (defense-in-depth — the server should have
	// rejected the open already, but the sidecar is the authority).
	info, ok := r.agents.Lookup(ev.AgentID)
	if !ok {
		r.publishClosed(ev.TerminalID, -1, fmt.Sprintf("agent %q is not running on this machine", ev.AgentID))
		return
	}
	if !info.SupportsTerminal {
		r.publishClosed(ev.TerminalID, -1, fmt.Sprintf("agent %q does not have terminal access enabled", ev.AgentID))
		return
	}

	r.mu.Lock()
	if _, exists := r.sessions[ev.TerminalID]; exists {
		r.mu.Unlock()
		r.log.Printf("terminal: %s already open, ignoring", ev.TerminalID)
		return
	}
	if len(r.sessions) >= r.settings.MaxSessions {
		r.mu.Unlock()
		r.publishClosed(ev.TerminalID, -1, fmt.Sprintf("max %d concurrent terminals reached", r.settings.MaxSessions))
		return
	}
	r.mu.Unlock()

	shell := ev.Shell
	if shell == "" {
		shell = r.settings.DefaultShell
	}
	if !containsString(r.settings.Shells, shell) {
		r.publishClosed(ev.TerminalID, -1, fmt.Sprintf("shell %q not allowed", shell))
		return
	}

	cwd := ev.Cwd
	if cwd == "" {
		cwd = info.WorkingDir
	}
	// Empty cwd → cmd inherits sidecar's cwd, which is fine.

	cols := ev.Cols
	rows := ev.Rows
	if cols <= 0 {
		cols = 120
	}
	if rows <= 0 {
		rows = 32
	}

	ctx, cancel := context.WithCancel(parent)
	cmd := exec.CommandContext(ctx, shell, "-l")
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		cancel()
		r.publishClosed(ev.TerminalID, -1, fmt.Sprintf("pty start: %v", err))
		return
	}

	sess := &ptySession{
		id:     ev.TerminalID,
		cmd:    cmd,
		pty:    f,
		cancel: cancel,
	}
	r.mu.Lock()
	r.sessions[ev.TerminalID] = sess
	r.mu.Unlock()
	r.log.Printf("terminal: opened %s shell=%s cwd=%s size=%dx%d", ev.TerminalID, shell, cwd, cols, rows)

	go r.pumpOutput(ctx, sess)
	go r.waitForExit(sess)
}

// pumpOutput reads PTY bytes and publishes output frames with an
// adaptive flush policy:
//   - idle → flush immediately (single keystroke echo hits the wire
//     with zero batching delay).
//   - in an active burst (another byte arrived within idleGap of the
//     last flush) → debounce by activeBurstInterval to amortize link
//     publishes across chatty output (shell redraws, `ls`, etc).
//
// Size cap (outputBatchMax) always wins: if a burst fills the buffer
// we publish mid-burst rather than waiting for the timer.
func (r *Runner) pumpOutput(ctx context.Context, s *ptySession) {
	buf := make([]byte, 32*1024)
	pending := make([]byte, 0, outputBatchMax)
	timer := time.NewTimer(activeBurstInterval)
	timer.Stop()
	timerArmed := false
	// Start in the "idle" state so the very first byte of the session
	// (typically the shell prompt) flushes without batching delay.
	lastFlush := time.Now().Add(-time.Hour)

	flush := func() {
		if len(pending) == 0 {
			return
		}
		s.outSeq++
		r.link.Publish(protocol.TerminalOutput{
			Kind:       protocol.TerminalKindOutput,
			TerminalID: s.id,
			Seq:        s.outSeq,
			Data:       base64.StdEncoding.EncodeToString(pending),
			TS:         time.Now().UnixMilli(),
		})
		pending = pending[:0]
		if timerArmed {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timerArmed = false
		}
		lastFlush = time.Now()
	}

	readDone := make(chan struct{})
	dataCh := make(chan []byte)
	errCh := make(chan error, 1)
	go func() {
		defer close(readDone)
		for {
			n, err := s.pty.Read(buf)
			if n > 0 {
				cp := make([]byte, n)
				copy(cp, buf[:n])
				select {
				case dataCh <- cp:
				case <-ctx.Done():
					return
				}
			}
			if err != nil {
				errCh <- err
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		case data := <-dataCh:
			pending = append(pending, data...)
			for len(pending) >= outputBatchMax {
				chunk := pending[:outputBatchMax]
				s.outSeq++
				r.link.Publish(protocol.TerminalOutput{
					Kind:       protocol.TerminalKindOutput,
					TerminalID: s.id,
					Seq:        s.outSeq,
					Data:       base64.StdEncoding.EncodeToString(chunk),
					TS:         time.Now().UnixMilli(),
				})
				pending = append(pending[:0], pending[outputBatchMax:]...)
				lastFlush = time.Now()
			}
			if len(pending) == 0 {
				continue
			}
			if time.Since(lastFlush) > idleGap {
				// Quiet period just ended — almost certainly a
				// user-visible event (keystroke echo or prompt
				// refresh). Publish without batching for minimum
				// echo latency.
				flush()
			} else if !timerArmed {
				timer.Reset(activeBurstInterval)
				timerArmed = true
			}
		case <-timer.C:
			timerArmed = false
			flush()
		case <-readDone:
			flush()
			return
		case err := <-errCh:
			flush()
			if err != nil && !errors.Is(err, io.EOF) {
				r.log.Printf("terminal: %s read error: %v", s.id, err)
			}
			return
		}
	}
}

func (r *Runner) waitForExit(s *ptySession) {
	err := s.cmd.Wait()
	r.mu.Lock()
	delete(r.sessions, s.id)
	r.mu.Unlock()
	s.cancel()
	_ = s.pty.Close()

	exit := 0
	reason := "exited"
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			exit = ee.ExitCode()
		} else {
			exit = -1
			reason = "error: " + err.Error()
		}
	}
	r.publishClosed(s.id, exit, reason)
	r.log.Printf("terminal: closed %s exit=%d reason=%s", s.id, exit, reason)
}

func (r *Runner) handleInput(ev protocol.TerminalInput) {
	r.mu.Lock()
	s := r.sessions[ev.TerminalID]
	r.mu.Unlock()
	if s == nil {
		return
	}
	data, err := base64.StdEncoding.DecodeString(ev.Data)
	if err != nil {
		r.log.Printf("terminal: %s bad input encoding: %v", ev.TerminalID, err)
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if _, err := s.pty.Write(data); err != nil {
		r.log.Printf("terminal: %s write error: %v", ev.TerminalID, err)
	}
}

func (r *Runner) handleResize(ev protocol.TerminalResize) {
	r.mu.Lock()
	s := r.sessions[ev.TerminalID]
	r.mu.Unlock()
	if s == nil {
		return
	}
	if ev.Cols <= 0 || ev.Rows <= 0 {
		return
	}
	if err := pty.Setsize(s.pty, &pty.Winsize{Cols: uint16(ev.Cols), Rows: uint16(ev.Rows)}); err != nil {
		r.log.Printf("terminal: %s resize error: %v", ev.TerminalID, err)
	}
}

func (r *Runner) handleClose(id, reason string) {
	r.mu.Lock()
	s := r.sessions[id]
	r.mu.Unlock()
	if s == nil {
		return
	}
	r.log.Printf("terminal: %s closing (%s)", id, reason)
	// Kill the process; waitForExit will publish terminal-closed.
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	s.cancel()
}

func (r *Runner) killAll(reason string) {
	r.mu.Lock()
	ids := make([]string, 0, len(r.sessions))
	for id := range r.sessions {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.handleClose(id, reason)
	}
}

func (r *Runner) publishClosed(terminalID string, exit int, reason string) {
	r.link.Publish(protocol.TerminalClosed{
		Kind:       protocol.TerminalKindClosed,
		TerminalID: terminalID,
		ExitCode:   exit,
		Reason:     reason,
		TS:         time.Now().UnixMilli(),
	})
}

func containsString(xs []string, target string) bool {
	for _, x := range xs {
		if x == target {
			return true
		}
	}
	return false
}

// splitCsv splits a comma-separated list, trimming whitespace and
// dropping empty tokens. Used for $ARGUS_TERMINAL_SHELLS parsing.
func splitCsv(s string) []string {
	out := make([]string, 0, 4)
	start := 0
	for i := 0; i <= len(s); i++ {
		if i == len(s) || s[i] == ',' {
			tok := s[start:i]
			j := 0
			for j < len(tok) && (tok[j] == ' ' || tok[j] == '\t') {
				j++
			}
			k := len(tok)
			for k > j && (tok[k-1] == ' ' || tok[k-1] == '\t') {
				k--
			}
			if k > j {
				out = append(out, tok[j:k])
			}
			start = i + 1
		}
	}
	return out
}

// Ensure Link (and thus *sidecarlink.Client) is importable for
// downstream callers that still reference the concrete type.
var _ Link = (*sidecarlink.Client)(nil)
