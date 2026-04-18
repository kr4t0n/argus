// Package sidecarlink is the sidecar side of the direct server link
// that carries terminal PTY traffic (and nothing else, at least today).
//
// It dials the server on boot, performs a small JSON handshake, and
// then exposes a duplex channel: `Publish(frame)` to send, `Inbound()`
// to receive. A background goroutine auto-reconnects with exponential
// backoff if the socket drops.
//
// The link is explicitly a best-effort, ephemeral transport: we do NOT
// buffer outbound frames across reconnects. If the link is down when a
// frame is published, Publish returns false and the caller logs it.
// This matches the server's behavior of force-closing the sidecar's
// terminals on disconnect — we can't pretend the PTYs are still alive.
package sidecarlink

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/kyley/argus/sidecar/internal/protocol"
)

const (
	// writeWait bounds how long a single Write can block before we
	// consider the socket wedged and bail. Has to be >> round-trip
	// to the server but << long enough that a stuck socket stalls
	// keystroke echo forever.
	writeWait = 3 * time.Second
	// pingInterval is the client-side keepalive. The server's idle
	// timeout in the hello-ack tells us the ceiling; we ping at
	// roughly a third of it.
	pingInterval = 15 * time.Second
	// pongWait is how long we wait for a pong after a ping before
	// tearing down. Must be > pingInterval + server latency.
	pongWait = 40 * time.Second

	dialTimeout = 10 * time.Second

	minReconnectBackoff = 500 * time.Millisecond
	maxReconnectBackoff = 30 * time.Second
)

type Client struct {
	serverURL string
	token     string
	sidecarID string
	log       *log.Logger

	// mu protects conn and connected.
	mu        sync.RWMutex
	conn      *websocket.Conn
	connected bool
	// writeMu serializes writes on the active conn. gorilla/websocket
	// requires at most one concurrent writer per connection.
	writeMu sync.Mutex

	inbound chan json.RawMessage
}

// New builds a Client. Call Run(ctx) in a goroutine to start the
// connect / reconnect loop.
func New(serverURL, token, sidecarID string, logger *log.Logger) *Client {
	return &Client{
		serverURL: serverURL,
		token:     token,
		sidecarID: sidecarID,
		log:       logger,
		inbound:   make(chan json.RawMessage, 256),
	}
}

// Run blocks until ctx is cancelled. It owns the reconnect loop; the
// public API (Publish, IsConnected) is safe to call before Run has
// produced a first connection (they'll just report disconnected).
func (c *Client) Run(ctx context.Context) {
	backoff := minReconnectBackoff
	for {
		if ctx.Err() != nil {
			return
		}
		if err := c.dialAndServe(ctx); err != nil {
			if ctx.Err() != nil {
				return
			}
			c.log.Printf("sidecarlink: %v (retry in %s)", err, backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff *= 2
			if backoff > maxReconnectBackoff {
				backoff = maxReconnectBackoff
			}
			continue
		}
		backoff = minReconnectBackoff
	}
}

func (c *Client) buildURL() (string, error) {
	// Support operators writing `http(s)://host:port` or `ws(s)://...`.
	base := strings.TrimRight(c.serverURL, "/")
	if strings.HasPrefix(base, "http://") {
		base = "ws://" + strings.TrimPrefix(base, "http://")
	} else if strings.HasPrefix(base, "https://") {
		base = "wss://" + strings.TrimPrefix(base, "https://")
	} else if !strings.HasPrefix(base, "ws://") && !strings.HasPrefix(base, "wss://") {
		return "", fmt.Errorf("server.url must start with http:// or https:// (got %q)", c.serverURL)
	}
	u, err := url.Parse(base + protocol.SidecarLinkPath)
	if err != nil {
		return "", err
	}
	q := u.Query()
	q.Set("id", c.sidecarID)
	if c.token != "" {
		q.Set("token", c.token)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func (c *Client) dialAndServe(ctx context.Context) error {
	target, err := c.buildURL()
	if err != nil {
		return err
	}

	dialCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	dialer := websocket.Dialer{
		HandshakeTimeout: dialTimeout,
	}
	conn, resp, err := dialer.DialContext(dialCtx, target, nil)
	if err != nil {
		if resp != nil {
			return fmt.Errorf("dial %s: %s (%w)", target, resp.Status, err)
		}
		return fmt.Errorf("dial %s: %w", target, err)
	}
	defer conn.Close()

	// Read the server's hello-ack before we mark ourselves connected —
	// that way the caller doesn't start publishing into a socket the
	// server may still reject.
	hello := protocol.SidecarHello{
		Kind:      protocol.LinkKindHello,
		SidecarID: c.sidecarID,
		TS:        time.Now().UnixMilli(),
	}
	if err := conn.WriteJSON(hello); err != nil {
		return fmt.Errorf("write hello: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(dialTimeout))
	var ack protocol.SidecarHelloAck
	if err := conn.ReadJSON(&ack); err != nil {
		return fmt.Errorf("read hello-ack: %w", err)
	}
	if ack.Kind != protocol.LinkKindHelloAck {
		return fmt.Errorf("unexpected handshake frame kind=%q", ack.Kind)
	}
	c.log.Printf("sidecarlink: connected (server ack idleTimeout=%dms)", ack.IdleTimeoutMS)

	// Pong handler extends the read deadline whenever a pong arrives.
	// This is how we detect a dead server (no pong for > pongWait).
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))

	c.mu.Lock()
	c.conn = conn
	c.connected = true
	c.mu.Unlock()

	// Ensure we tear down connected-state on any exit path, so callers
	// don't keep trying to Publish to a half-dead socket.
	defer func() {
		c.mu.Lock()
		c.conn = nil
		c.connected = false
		c.mu.Unlock()
	}()

	errCh := make(chan error, 2)
	// Reader goroutine.
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				errCh <- err
				return
			}
			// Non-blocking send with a drop-oldest policy: if the
			// downstream router is slow we'd rather lose the oldest
			// keystroke echo than block the socket read loop (which
			// would stall pings and trigger a false timeout).
			select {
			case c.inbound <- append(json.RawMessage(nil), data...):
			default:
				select {
				case <-c.inbound: // drop oldest
				default:
				}
				select {
				case c.inbound <- append(json.RawMessage(nil), data...):
				default:
				}
			}
		}
	}()
	// Ping ticker goroutine.
	go func() {
		t := time.NewTicker(pingInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				errCh <- ctx.Err()
				return
			case <-t.C:
				c.writeMu.Lock()
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				err := conn.WriteMessage(websocket.PingMessage, nil)
				c.writeMu.Unlock()
				if err != nil {
					errCh <- fmt.Errorf("ping: %w", err)
					return
				}
			}
		}
	}()

	select {
	case <-ctx.Done():
		// Best-effort graceful close.
		c.writeMu.Lock()
		_ = conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseNormalClosure, "sidecar shutdown"),
			time.Now().Add(writeWait),
		)
		c.writeMu.Unlock()
		return ctx.Err()
	case err := <-errCh:
		if errors.Is(err, context.Canceled) {
			return err
		}
		return fmt.Errorf("link io: %w", err)
	}
}

// IsConnected reports whether the link currently has an open socket.
// Useful for avoiding pointless work (e.g. expensive PTY setup) when
// the server is unreachable.
func (c *Client) IsConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connected
}

// Publish sends a JSON frame. Returns false if the link is not
// connected. Thread-safe: a write mutex serializes concurrent calls.
func (c *Client) Publish(frame any) bool {
	c.mu.RLock()
	conn := c.conn
	connected := c.connected
	c.mu.RUnlock()
	if !connected || conn == nil {
		return false
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
	if err := conn.WriteJSON(frame); err != nil {
		c.log.Printf("sidecarlink: publish failed: %v", err)
		// Proactively close so the read loop unblocks and we reconnect
		// rather than spin on dead writes.
		_ = conn.Close()
		return false
	}
	return true
}

// Inbound returns a channel of raw JSON frames from the server. The
// consumer is expected to decode them by peeking at the `kind` field.
func (c *Client) Inbound() <-chan json.RawMessage {
	return c.inbound
}
