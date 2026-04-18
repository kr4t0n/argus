package bus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type Bus struct {
	rdb *redis.Client
}

func Dial(ctx context.Context, url string) (*Bus, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("ping redis: %w", err)
	}
	return &Bus{rdb: rdb}, nil
}

func (b *Bus) Close() error { return b.rdb.Close() }

// Publish adds a JSON payload to `stream` as a single-field entry `data`.
func (b *Bus) Publish(ctx context.Context, stream string, payload any) error {
	buf, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return b.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: stream,
		MaxLen: 10_000,
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
