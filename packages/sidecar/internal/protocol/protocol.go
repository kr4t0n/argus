// Package protocol mirrors packages/shared-types/src/protocol.ts.
// When you change one, change the other.
package protocol

type AgentStatus string

const (
	StatusOnline  AgentStatus = "online"
	StatusOffline AgentStatus = "offline"
	StatusBusy    AgentStatus = "busy"
	StatusError   AgentStatus = "error"
)

type ResultKind string

const (
	KindDelta    ResultKind = "delta"
	KindStdout   ResultKind = "stdout"
	KindStderr   ResultKind = "stderr"
	KindTool     ResultKind = "tool"
	KindProgress ResultKind = "progress"
	KindFinal    ResultKind = "final"
	KindError    ResultKind = "error"
)

type RegisterEvent struct {
	Kind         string   `json:"kind"` // "register"
	ID           string   `json:"id"`
	Type         string   `json:"type"`
	Machine      string   `json:"machine"`
	Capabilities []string `json:"capabilities"`
	Version      string   `json:"version"`
	WorkingDir   string   `json:"workingDir,omitempty"`
	TS           int64    `json:"ts"`
}

type HeartbeatEvent struct {
	Kind   string      `json:"kind"` // "heartbeat"
	ID     string      `json:"id"`
	Status AgentStatus `json:"status"`
	TS     int64       `json:"ts"`
}

type DeregisterEvent struct {
	Kind string `json:"kind"` // "deregister"
	ID   string `json:"id"`
	TS   int64  `json:"ts"`
}

type Command struct {
	ID         string                 `json:"id"`
	AgentID    string                 `json:"agentId"`
	SessionID  string                 `json:"sessionId"`
	ExternalID string                 `json:"externalId,omitempty"`
	Kind       string                 `json:"kind"` // "execute" | "cancel"
	Prompt     string                 `json:"prompt,omitempty"`
	Context    map[string]any         `json:"context,omitempty"`
	TimeoutMS  int                    `json:"timeoutMs,omitempty"`
	Options    map[string]any         `json:"options,omitempty"`
}

type ResultChunk struct {
	ID        string         `json:"id"`
	CommandID string         `json:"commandId"`
	AgentID   string         `json:"agentId"`
	SessionID string         `json:"sessionId"`
	Seq       int            `json:"seq"`
	Kind      ResultKind     `json:"kind"`
	Delta     string         `json:"delta,omitempty"`
	Content   string         `json:"content,omitempty"`
	Meta      map[string]any `json:"meta,omitempty"`
	TS        int64          `json:"ts"`
	IsFinal   bool           `json:"isFinal"`
}

type SessionExternalIDEvent struct {
	Kind       string `json:"kind"` // "session-external-id"
	SessionID  string `json:"sessionId"`
	CommandID  string `json:"commandId"`
	ExternalID string `json:"externalId"`
	TS         int64  `json:"ts"`
}

// ─────────── Terminal protocol ───────────
//
// Multiplexed over per-agent in/out streams, keyed by terminalId. Data
// payloads are base64 strings so binary keystrokes (e.g. 0x03 SIGINT)
// survive a JSON round-trip.

const (
	TerminalKindOpen         = "terminal-open"
	TerminalKindInput        = "terminal-input"
	TerminalKindResize       = "terminal-resize"
	TerminalKindCloseRequest = "terminal-close"
	TerminalKindOutput       = "terminal-output"
	TerminalKindClosed       = "terminal-closed"
)

type TerminalOpen struct {
	Kind       string `json:"kind"`
	TerminalID string `json:"terminalId"`
	AgentID    string `json:"agentId"`
	Shell      string `json:"shell,omitempty"`
	Cwd        string `json:"cwd,omitempty"`
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
	TS         int64  `json:"ts"`
}

type TerminalInput struct {
	Kind       string `json:"kind"`
	TerminalID string `json:"terminalId"`
	Data       string `json:"data"` // base64
	TS         int64  `json:"ts"`
}

type TerminalResize struct {
	Kind       string `json:"kind"`
	TerminalID string `json:"terminalId"`
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
	TS         int64  `json:"ts"`
}

type TerminalCloseRequest struct {
	Kind       string `json:"kind"`
	TerminalID string `json:"terminalId"`
	TS         int64  `json:"ts"`
}

type TerminalOutput struct {
	Kind       string `json:"kind"`
	TerminalID string `json:"terminalId"`
	Seq        int    `json:"seq"`
	Data       string `json:"data"` // base64
	TS         int64  `json:"ts"`
}

type TerminalClosed struct {
	Kind       string `json:"kind"`
	TerminalID string `json:"terminalId"`
	ExitCode   int    `json:"exitCode"`
	Reason     string `json:"reason,omitempty"`
	TS         int64  `json:"ts"`
}

// ─────────── Sidecar ↔ server direct link ───────────
//
// Terminal traffic rides a direct WebSocket between the sidecar and
// the server. Commands / lifecycle / results still flow through Redis
// Streams.

const (
	SidecarLinkPath   = "/sidecar-link"
	LinkKindHello     = "hello"
	LinkKindHelloAck  = "hello-ack"
)

type SidecarHello struct {
	Kind      string `json:"kind"` // "hello"
	SidecarID string `json:"sidecarId"`
	TS        int64  `json:"ts"`
}

type SidecarHelloAck struct {
	Kind          string `json:"kind"` // "hello-ack"
	TS            int64  `json:"ts"`
	IdleTimeoutMS int64  `json:"idleTimeoutMs"`
}

// Stream key helpers (Redis Streams — commands/lifecycle/results only).
func LifecycleStream() string                      { return "agent:lifecycle" }
func CommandStream(id string) string               { return "agent:" + id + ":cmd" }
func ResultStream(id string) string                { return "agent:" + id + ":result" }
func SidecarConsumerGroup(id string) string        { return "sidecar-" + id }
