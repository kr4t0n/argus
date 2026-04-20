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

// RegisterEvent is emitted by an agent supervisor inside the machine
// daemon when it (re-)spawns. The Agent row already exists in Postgres
// (created by the dashboard via POST /machines/:id/agents); the server
// uses this to flip status and refresh metadata.
type RegisterEvent struct {
	Kind             string `json:"kind"` // "register"
	ID               string `json:"id"`
	MachineID        string `json:"machineId"`
	Type             string `json:"type"`
	SupportsTerminal bool   `json:"supportsTerminal"`
	Version          string `json:"version"`
	WorkingDir       string `json:"workingDir,omitempty"`
	TS               int64  `json:"ts"`
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

// ─────────── Machine lifecycle ───────────
//
// The sidecar daemon emits these on the same agent:lifecycle stream
// that agent supervisors use, discriminated by Kind.

// AvailableAdapter is one CLI adapter the sidecar found on PATH at boot.
type AvailableAdapter struct {
	Type    string `json:"type"`
	Binary  string `json:"binary"`
	Version string `json:"version,omitempty"`
}

type MachineRegisterEvent struct {
	Kind              string             `json:"kind"` // "machine-register"
	MachineID         string             `json:"machineId"`
	Name              string             `json:"name"`
	Hostname          string             `json:"hostname"`
	OS                string             `json:"os"`
	Arch              string             `json:"arch"`
	SidecarVersion    string             `json:"sidecarVersion"`
	AvailableAdapters []AvailableAdapter `json:"availableAdapters"`
	TS                int64              `json:"ts"`
}

type MachineHeartbeatEvent struct {
	Kind      string `json:"kind"` // "machine-heartbeat"
	MachineID string `json:"machineId"`
	TS        int64  `json:"ts"`
}

// ─────────── Machine control commands (server → sidecar) ───────────

// AgentSpec is the canonical shape both Create and Sync embed; mirrors
// what the sidecar persists in its on-disk cache.
type AgentSpec struct {
	AgentID          string         `json:"agentId"`
	Name             string         `json:"name"`
	Type             string         `json:"type"`
	WorkingDir       string         `json:"workingDir,omitempty"`
	SupportsTerminal bool           `json:"supportsTerminal"`
	Adapter          map[string]any `json:"adapter,omitempty"`
}

type CreateAgentCommand struct {
	Kind  string    `json:"kind"` // "create-agent"
	Agent AgentSpec `json:"agent"`
	TS    int64     `json:"ts"`
}

type DestroyAgentCommand struct {
	Kind    string `json:"kind"` // "destroy-agent"
	AgentID string `json:"agentId"`
	TS      int64  `json:"ts"`
}

type SyncAgentsCommand struct {
	Kind   string      `json:"kind"` // "sync-agents"
	Agents []AgentSpec `json:"agents"`
	TS     int64       `json:"ts"`
}

// ─────────── Filesystem browsing ───────────
//
// Request (server → sidecar) rides the machine control stream; the
// response and the unsolicited fsnotify change events both ride the
// shared lifecycle stream so the server's single lifecycle consumer
// ingests them alongside every other sidecar → server event.

// FSEntry is one entry in a directory listing.
type FSEntry struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"` // "file" | "dir" | "symlink"
	Size       int64  `json:"size"`
	MTime      int64  `json:"mtime"`
	Gitignored bool   `json:"gitignored,omitempty"`
}

type FSListRequestCommand struct {
	Kind      string `json:"kind"` // "fs-list"
	RequestID string `json:"requestId"`
	AgentID   string `json:"agentId"`
	Path      string `json:"path"`
	ShowAll   bool   `json:"showAll"`
	TS        int64  `json:"ts"`
}

type FSListResponseEvent struct {
	Kind      string    `json:"kind"` // "fs-list-response"
	MachineID string    `json:"machineId"`
	AgentID   string    `json:"agentId"`
	RequestID string    `json:"requestId"`
	Path      string    `json:"path"`
	Entries   []FSEntry `json:"entries,omitempty"`
	Error     string    `json:"error,omitempty"`
	TS        int64     `json:"ts"`
}

type FSChangedEvent struct {
	Kind      string `json:"kind"` // "fs-changed"
	MachineID string `json:"machineId"`
	AgentID   string `json:"agentId"`
	Path      string `json:"path"`
	TS        int64  `json:"ts"`
}

// ─────────── Sidecar acks (sidecar → server, on agent:lifecycle) ───────────

type AgentSpawnedEvent struct {
	Kind      string `json:"kind"` // "agent-spawned"
	MachineID string `json:"machineId"`
	AgentID   string `json:"agentId"`
	TS        int64  `json:"ts"`
}

type AgentSpawnFailedEvent struct {
	Kind      string `json:"kind"` // "agent-spawn-failed"
	MachineID string `json:"machineId"`
	AgentID   string `json:"agentId"`
	Reason    string `json:"reason"`
	TS        int64  `json:"ts"`
}

type AgentDestroyedEvent struct {
	Kind      string `json:"kind"` // "agent-destroyed"
	MachineID string `json:"machineId"`
	AgentID   string `json:"agentId"`
	TS        int64  `json:"ts"`
}

type Command struct {
	ID         string         `json:"id"`
	AgentID    string         `json:"agentId"`
	SessionID  string         `json:"sessionId"`
	ExternalID string         `json:"externalId,omitempty"`
	Kind       string         `json:"kind"` // "execute" | "cancel"
	Prompt     string         `json:"prompt,omitempty"`
	Context    map[string]any `json:"context,omitempty"`
	TimeoutMS  int            `json:"timeoutMs,omitempty"`
	Options    map[string]any `json:"options,omitempty"`
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
	SidecarLinkPath  = "/sidecar-link"
	LinkKindHello    = "hello"
	LinkKindHelloAck = "hello-ack"
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

// Stream key helpers (Redis Streams — commands/lifecycle/results/control only).
func LifecycleStream() string                      { return "agent:lifecycle" }
func CommandStream(id string) string               { return "agent:" + id + ":cmd" }
func ResultStream(id string) string                { return "agent:" + id + ":result" }
func MachineControlStream(machineID string) string { return "machine:" + machineID + ":control" }
func MachineConsumerGroup(machineID string) string { return "machine-" + machineID }

// SidecarConsumerGroup is the consumer group name an agent supervisor
// uses on its own per-agent command stream. We name it after the agent
// itself so two supervisors for the same agent (a brief overlap during
// daemon restart) share a single group and cooperatively drain pending
// entries instead of double-delivering.
func SidecarConsumerGroup(agentID string) string { return "sidecar-" + agentID }
