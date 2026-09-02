package adapter

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// codexAppServer is one turn-scoped JSONL connection to `codex app-server`.
// Notifications are correlated by turn id, and closing stdin after the turn
// makes app-server release its thread-store writer immediately.
type codexAppServer struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser

	writeMu sync.Mutex
	nextID  atomic.Int64

	mu       sync.Mutex
	pending  map[int64]chan appServerResponse
	turns    map[string]*codexAppRun
	buffered map[string][]codexAppEvent
	usage    map[string]map[string]any

	done      chan struct{}
	closeOnce sync.Once
	failErr   error
	stderrMu  sync.Mutex
	stderr    []string
}

type appServerResponse struct {
	result json.RawMessage
	err    error
}

type appServerError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *appServerError) Error() string {
	if e.Code == 0 {
		return e.Message
	}
	return fmt.Sprintf("%s (code %d)", e.Message, e.Code)
}

type codexAppEvent struct {
	method string
	params json.RawMessage
}

type codexAppRun struct {
	events chan codexAppEvent
}

func startCodexAppServer(ctx context.Context, binary, workingDir string, extraArgs []string) (*codexAppServer, error) {
	args := append([]string{"app-server", "--stdio"}, extraArgs...)
	cmd := exec.Command(binary, args...)
	if workingDir != "" {
		cmd.Dir = workingDir
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("codex app-server stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("codex app-server stdout: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("codex app-server stderr: %w", err)
	}

	s := &codexAppServer{
		cmd:      cmd,
		stdin:    stdin,
		pending:  make(map[int64]chan appServerResponse),
		turns:    make(map[string]*codexAppRun),
		buffered: make(map[string][]codexAppEvent),
		usage:    make(map[string]map[string]any),
		done:     make(chan struct{}),
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start codex app-server: %w", err)
	}
	go s.readLoop(stdout)
	go s.readStderr(stderr)
	go func() {
		err := cmd.Wait()
		if err == nil {
			err = errors.New("codex app-server exited")
		}
		s.fail(err)
	}()

	initCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err = s.request(initCtx, "initialize", map[string]any{
		"clientInfo": map[string]any{
			"name":    "argus_sidecar",
			"title":   "Argus Sidecar",
			"version": "0.3",
		},
	})
	if err != nil {
		_ = s.Close()
		return nil, fmt.Errorf("initialize codex app-server: %w", err)
	}
	if err := s.notify("initialized", map[string]any{}); err != nil {
		_ = s.Close()
		return nil, fmt.Errorf("acknowledge codex app-server initialization: %w", err)
	}
	return s, nil
}

func (s *codexAppServer) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := s.nextID.Add(1)
	ch := make(chan appServerResponse, 1)
	s.mu.Lock()
	if s.failErr != nil {
		err := s.failErr
		s.mu.Unlock()
		return nil, err
	}
	s.pending[id] = ch
	s.mu.Unlock()

	if err := s.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return nil, err
	}
	select {
	case resp := <-ch:
		return resp.result, resp.err
	case <-ctx.Done():
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
		return nil, ctx.Err()
	case <-s.done:
		s.mu.Lock()
		err := s.failErr
		s.mu.Unlock()
		if err == nil {
			err = errors.New("codex app-server closed")
		}
		return nil, err
	}
}

func (s *codexAppServer) notify(method string, params any) error {
	return s.write(map[string]any{"method": method, "params": params})
}

func (s *codexAppServer) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err = s.stdin.Write(b)
	if err != nil {
		return fmt.Errorf("write codex app-server request: %w", err)
	}
	return nil
}

func (s *codexAppServer) readLoop(stdout io.Reader) {
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var msg struct {
			ID     *int64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  *appServerError `json:"error"`
		}
		if err := json.Unmarshal(line, &msg); err != nil {
			continue
		}
		if msg.ID != nil && msg.Method == "" {
			resp := appServerResponse{result: msg.Result}
			if msg.Error != nil {
				resp.err = msg.Error
			}
			s.deliverResponse(*msg.ID, resp)
			continue
		}
		if msg.ID != nil && msg.Method != "" {
			// Argus runs Codex with approvals disabled. Decline any unexpected
			// server request instead of leaving the app-server waiting forever.
			_ = s.write(map[string]any{
				"id":    *msg.ID,
				"error": map[string]any{"code": -32601, "message": "Argus does not handle this server request"},
			})
			continue
		}
		if msg.Method != "" {
			s.deliverEvent(codexAppEvent{method: msg.Method, params: msg.Params})
		}
	}
	if err := sc.Err(); err != nil {
		s.fail(fmt.Errorf("read codex app-server: %w", err))
	}
}

func (s *codexAppServer) readStderr(stderr io.Reader) {
	sc := bufio.NewScanner(stderr)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		s.stderrMu.Lock()
		s.stderr = append(s.stderr, line)
		if len(s.stderr) > 8 {
			s.stderr = s.stderr[len(s.stderr)-8:]
		}
		s.stderrMu.Unlock()
	}
}

func (s *codexAppServer) deliverResponse(id int64, resp appServerResponse) {
	s.mu.Lock()
	ch := s.pending[id]
	delete(s.pending, id)
	s.mu.Unlock()
	if ch != nil {
		ch <- resp
	}
}

func (s *codexAppServer) deliverEvent(ev codexAppEvent) {
	turnID := eventTurnID(ev.params)
	s.mu.Lock()
	if ev.method == "thread/tokenUsage/updated" {
		threadID, total := eventThreadUsage(ev.params)
		if threadID != "" && total != nil {
			s.usage[threadID] = total
		}
	}
	if turnID == "" {
		s.mu.Unlock()
		return
	}
	run := s.turns[turnID]
	if run == nil {
		s.buffered[turnID] = append(s.buffered[turnID], ev)
		s.mu.Unlock()
		return
	}
	run.events <- ev
	if ev.method == "turn/completed" {
		delete(s.turns, turnID)
		close(run.events)
	}
	s.mu.Unlock()
}

func eventThreadUsage(raw json.RawMessage) (string, map[string]any) {
	var p struct {
		ThreadID   string `json:"threadId"`
		TokenUsage struct {
			Total map[string]any `json:"total"`
		} `json:"tokenUsage"`
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(&p); err != nil {
		return "", nil
	}
	return p.ThreadID, p.TokenUsage.Total
}

func eventTurnID(raw json.RawMessage) string {
	var p struct {
		TurnID string `json:"turnId"`
		Turn   struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	_ = json.Unmarshal(raw, &p)
	if p.TurnID != "" {
		return p.TurnID
	}
	return p.Turn.ID
}

func (s *codexAppServer) subscribe(turnID string) *codexAppRun {
	run := &codexAppRun{events: make(chan codexAppEvent, 256)}
	s.mu.Lock()
	s.turns[turnID] = run
	queued := s.buffered[turnID]
	delete(s.buffered, turnID)
	for _, ev := range queued {
		run.events <- ev
		if ev.method == "turn/completed" {
			delete(s.turns, turnID)
			close(run.events)
			break
		}
	}
	s.mu.Unlock()
	return run
}

func (s *codexAppServer) threadUsageTotal(threadID string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneAnyMap(s.usage[threadID])
}

func cloneAnyMap(src map[string]any) map[string]any {
	if src == nil {
		return nil
	}
	dst := make(map[string]any, len(src))
	for key, value := range src {
		dst[key] = value
	}
	return dst
}

func (s *codexAppServer) fail(err error) {
	s.closeOnce.Do(func() {
		s.stderrMu.Lock()
		if len(s.stderr) > 0 {
			err = fmt.Errorf("%w: %s", err, strings.Join(s.stderr, "; "))
		}
		s.stderrMu.Unlock()

		s.mu.Lock()
		s.failErr = err
		for id, ch := range s.pending {
			ch <- appServerResponse{err: err}
			delete(s.pending, id)
		}
		for id, run := range s.turns {
			run.events <- codexAppEvent{method: "argus/app-server-error", params: mustJSON(map[string]any{"message": err.Error()})}
			close(run.events)
			delete(s.turns, id)
		}
		s.mu.Unlock()
		close(s.done)
	})
}

func (s *codexAppServer) Close() error {
	_ = s.stdin.Close()
	select {
	case <-s.done:
		return nil
	case <-time.After(5 * time.Second):
		if s.cmd.Process != nil {
			_ = s.cmd.Process.Kill()
		}
		<-s.done
		return nil
	}
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
