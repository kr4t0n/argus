package bus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

type Bus struct {
	rdb *redis.Client
}

func Dial(ctx context.Context, url string) (*Bus, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	// Cap the connection pool. The go-redis defaults are sized for a
	// dedicated Redis (PoolSize = 10×GOMAXPROCS, idle conns never closed:
	// v9 has no background reaper, ConnMaxIdleTime is only checked lazily
	// at checkout, and the default LIFO pool never revisits conns below
	// the hot top-of-stack). Our Redis Cloud plan allows 30 clients TOTAL
	// across the fleet, and concurrent fire-and-forget XADDs (result
	// chunks, fs/git responses, watcher events) at ~150ms RTT can balloon
	// an uncapped pool by 15+ sockets in one burst that then never shrink.
	// Two conns stay parked in blocking XREADGROUPs (control + command
	// reader); the rest serve publishes — 6 conns ≈ 40 XADD/s at 150ms
	// RTT, far above real inflow. MaxIdleConns trims back to 3 as burst
	// conns are released; FIFO rotation makes the 5m idle expiry actually
	// reach every conn.
	opt.PoolSize = 8
	opt.MaxActiveConns = 8
	opt.MaxIdleConns = 3
	opt.ConnMaxIdleTime = 5 * time.Minute
	opt.PoolFIFO = true
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("ping redis: %w", err)
	}
	return &Bus{rdb: rdb}, nil
}

func (b *Bus) Close() error { return b.rdb.Close() }

// Publish adds a JSON payload to `stream` as a single-field entry `data`.
// The MAXLEN cap is keyed off the stream name via `protocol.StreamMaxLen`
// so each stream class gets a size appropriate for its volume and
// consumer-lag tolerance.
func (b *Bus) Publish(ctx context.Context, stream string, payload any) error {
	buf, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return b.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: stream,
		MaxLen: protocol.StreamMaxLen(stream),
		Approx: true,
		Values: map[string]any{"data": buf},
	}).Err()
}

// EnsureGroup creates a consumer group on `stream` if it doesn't already exist.
func (b *Bus) EnsureGroup(ctx context.Context, stream, group string) error {
	err := b.rdb.XGroupCreateMkStream(ctx, stream, group, "$").Err()
	if err == nil {
		return nil
	}
	if err.Error() == "BUSYGROUP Consumer Group name already exists" {
		return nil
	}
	return err
}

// ReadMessage blocks for up to `block` waiting for a single message on
// `stream`/`group`. Returns (msgID, decoded-json, nil) on success, or
// (empty, nil, nil) on timeout.
func (b *Bus) ReadMessage(
	ctx context.Context,
	stream, group, consumer string,
	block time.Duration,
) (string, map[string]any, error) {
	res, err := b.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
		Group:    group,
		Consumer: consumer,
		Streams:  []string{stream, ">"},
		Count:    1,
		Block:    block,
	}).Result()
	if errors.Is(err, redis.Nil) {
		return "", nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	if len(res) == 0 || len(res[0].Messages) == 0 {
		return "", nil, nil
	}
	msg := res[0].Messages[0]
	raw, ok := msg.Values["data"].(string)
	if !ok {
		return msg.ID, nil, fmt.Errorf("missing data field")
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return msg.ID, nil, err
	}
	return msg.ID, payload, nil
}

func (b *Bus) Ack(ctx context.Context, stream, group, id string) error {
	return b.rdb.XAck(ctx, stream, group, id).Err()
}

// StreamMessage is one decoded entry returned by ReadGroupMulti, tagged
// with the stream it came from so the caller can route it to the right
// handler. Payload is nil when the entry was malformed (missing or
// non-JSON `data` field) — the caller should ack-drop those rather than
// leak them in the consumer group's pending list.
type StreamMessage struct {
	Stream  string
	ID      string
	Payload map[string]any
}

// ReadGroupMulti blocks for up to `block` on a single XREADGROUP that
// fans in over many streams at once, all under one consumer group. This
// is what lets the sidecar consume every agent's command stream on a
// single connection instead of one blocking reader per agent.
//
// `count` caps entries per stream per call. A redis.Nil (block elapsed,
// nothing ready) maps to (nil, nil). On any other error the batch is
// abandoned and the error returned — notably NOGROUP, which the caller
// recreates the group(s) for and retries.
func (b *Bus) ReadGroupMulti(
	ctx context.Context,
	streams []string,
	group, consumer string,
	count int64,
	block time.Duration,
) ([]StreamMessage, error) {
	if len(streams) == 0 {
		return nil, nil
	}
	// XREADGROUP wants all stream keys followed by one ID per stream.
	args := make([]string, 0, len(streams)*2)
	args = append(args, streams...)
	for range streams {
		args = append(args, ">")
	}
	res, err := b.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
		Group:    group,
		Consumer: consumer,
		Streams:  args,
		Count:    count,
		Block:    block,
	}).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []StreamMessage
	for _, st := range res {
		for _, msg := range st.Messages {
			sm := StreamMessage{Stream: st.Stream, ID: msg.ID}
			if raw, ok := msg.Values["data"].(string); ok {
				var payload map[string]any
				if json.Unmarshal([]byte(raw), &payload) == nil {
					sm.Payload = payload
				}
			}
			out = append(out, sm)
		}
	}
	return out, nil
}
