// Package terminal serves interactive PTY sessions on the agent's host
// machine. It mirrors the lifecycle/command pattern: subscribe to a
// per-agent input stream, fan-out per-terminal goroutines that own a
// PTY each, and publish output to a per-agent output stream.
//
// Security model: a sidecar only runs this if `terminal.enabled: true`
// in its YAML. The PTY inherits the sidecar's UID, so anyone with
// dashboard access effectively gets shell-as-sidecar-user on this host.
// Treat opt-in as equivalent to handing out SSH access.
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

	"github.com/kyley/argus/sidecar/internal/bus"
	"github.com/kyley/argus/sidecar/internal/config"
	"github.com/kyley/argus/sidecar/internal/protocol"
)

const (
	// activeBurstInterval is how long we wait for more bytes once we're
	// already inside a burst. Keep it tight: local echo of a single
	// keystroke should still feel snappy even when adjacent bytes come
	// in back-to-back (e.g. shell redraws).
	activeBurstInterval = 4 * time.Millisecond
	// idleGap is the window we use to detect "first byte after quiet".
	// If we've published nothing for longer than this, the next arrival
	// is almost certainly a user keystroke and we flush it immediately
	// (no batching) to minimize echo latency. Bytes arriving faster
	// than this are treated as part of an ongoing burst and get the
	// (much cheaper) active-burst debounce.
	idleGap = 8 * time.Millisecond
	// outputBatchMax bounds the size of a single output message. Larger
	// payloads risk Redis stream entry limits and waste UI render time.
	outputBatchMax = 16 * 1024
	// readBlock is the XREADGROUP block timeout for the input stream.
	readBlock = 2 * time.Second
)

type Runner struct {
	cfg *config.Config
	bus *bus.Bus
	log *log.Logger

	mu       sync.Mutex
	sessions map[string]*ptySession
}

type ptySession struct {
	id     string
	cmd    *exec.Cmd
	pty    *os.File
	cancel context.CancelFunc
	// outSeq is monotonically incremented per output message published.
	outSeq int
	// writeMu guards writes to the PTY (input arrives on a single
	// goroutine today, but cheap to be defensive).
	writeMu sync.Mutex
}

func New(cfg *config.Config, b *bus.Bus, logger *log.Logger) *Runner {
	return &Runner{
		cfg:      cfg,
		bus:      b,
		log:      logger,
		sessions: make(map[string]*ptySession),
	}
}

// Run blocks until ctx is cancelled. Spawn it in its own goroutine; on
// ctx.Done() it kills every active PTY and returns.
func (r *Runner) Run(ctx context.Context) error {
	stream := protocol.TerminalInStream(r.cfg.ID)
	group := protocol.SidecarTerminalConsumerGroup(r.cfg.ID)
	if err := r.bus.EnsureGroup(ctx, stream, group); err != nil {
		return fmt.Errorf("ensure terminal group: %w", err)
	}
	consumer := "term-c-" + r.cfg.ID
	r.log.Printf("terminal: ready (max=%d shells=%v)", r.cfg.Terminal.MaxSessions, r.cfg.Terminal.Shells)

	for {
		if ctx.Err() != nil {
			break
		}
		msgID, payload, err := r.bus.ReadMessage(ctx, stream, group, consumer, readBlock)
		if errors.Is(err, context.Canceled) {
			break
		}
		if err != nil {
			r.log.Printf("terminal read error: %v", err)
			time.Sleep(time.Second)
			continue
		}
		if msgID == "" {
			continue
		}
		r.dispatch(ctx, payload)
		_ = r.bus.Ack(ctx, stream, group, msgID)
	}

	r.killAll("sidecar shutdown")
	return nil
}

func (r *Runner) dispatch(ctx context.Context, payload map[string]any) {
	kind, _ := payload["kind"].(string)
	switch kind {
	case protocol.TerminalKindOpen:
		var ev protocol.TerminalOpen
		if err := remap(payload, &ev); err != nil {
			r.log.Printf("terminal: bad open: %v", err)
			return
		}
		r.handleOpen(ctx, ev)
	case protocol.TerminalKindInput:
		var ev protocol.TerminalInput
		if err := remap(payload, &ev); err != nil {
			r.log.Printf("terminal: bad input: %v", err)
			return
		}
		r.handleInput(ev)
	case protocol.TerminalKindResize:
		var ev protocol.TerminalResize
		if err := remap(payload, &ev); err != nil {
			r.log.Printf("terminal: bad resize: %v", err)
			return
		}
		r.handleResize(ev)
	case protocol.TerminalKindCloseRequest:
		var ev protocol.TerminalCloseRequest
		if err := remap(payload, &ev); err != nil {
			r.log.Printf("terminal: bad close: %v", err)
			return
		}
		r.handleClose(ev.TerminalID, "closed by client")
	default:
		r.log.Printf("terminal: unknown kind %q", kind)
	}
}

func (r *Runner) handleOpen(parent context.Context, ev protocol.TerminalOpen) {
	if ev.TerminalID == "" {
		r.log.Printf("terminal: open missing terminalId")
		return
	}

	r.mu.Lock()
	if _, exists := r.sessions[ev.TerminalID]; exists {
		r.mu.Unlock()
		r.log.Printf("terminal: %s already open, ignoring", ev.TerminalID)
		return
	}
	if len(r.sessions) >= r.cfg.Terminal.MaxSessions {
		r.mu.Unlock()
		r.publishClosed(ev.TerminalID, -1, fmt.Sprintf("max %d concurrent terminals reached", r.cfg.Terminal.MaxSessions))
		return
	}
	r.mu.Unlock()

	shell := ev.Shell
	if shell == "" {
		shell = r.cfg.Terminal.DefaultShell
	}
	if !containsString(r.cfg.Terminal.Shells, shell) {
		r.publishClosed(ev.TerminalID, -1, fmt.Sprintf("shell %q not allowed", shell))
		return
	}

	cwd := ev.Cwd
	if cwd == "" {
		cwd = r.cfg.Terminal.Cwd
	}
	if cwd == "" {
		cwd = r.cfg.WorkingDir
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

	// Output pump.
	go r.pumpOutput(ctx, sess)
	// Wait-and-cleanup.
	go r.waitForExit(sess)
}

// pumpOutput reads PTY bytes and publishes output messages with an
// adaptive flush policy:
//   - idle → flush immediately (single keystroke echo hits the wire
//     with zero batching delay).
//   - in an active burst (another byte arrived within idleGap of the
//     last flush) → debounce by activeBurstInterval to amortize Redis
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
		_ = r.bus.Publish(context.Background(), protocol.TerminalOutStream(r.cfg.ID), protocol.TerminalOutput{
			Kind:       protocol.TerminalKindOutput,
			TerminalID: s.id,
			Seq:        s.outSeq,
			Data:       base64.StdEncoding.EncodeToString(pending),
			TS:         time.Now().UnixMilli(),
		})
		pending = pending[:0]
		if timerArmed {
			// Drain a pending tick so the next Reset starts clean.
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
				_ = r.bus.Publish(context.Background(), protocol.TerminalOutStream(r.cfg.ID), protocol.TerminalOutput{
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
				// Quiet period just ended — almost certainly a user-
				// visible event (keystroke echo or prompt refresh).
				// Publish without batching for minimum echo latency.
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
	// Send SIGHUP-equivalent by killing the process; waitForExit will
	// publish the terminal-closed event when cmd.Wait returns.
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
	_ = r.bus.Publish(context.Background(), protocol.TerminalOutStream(r.cfg.ID), protocol.TerminalClosed{
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

// remap converts an arbitrary JSON-decoded map back into a typed struct
// via JSON. We accept the round-trip cost (sidecar message rates are
// tiny) for the simplicity of not maintaining bespoke decoders per kind.
func remap(in map[string]any, out any) error {
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}
