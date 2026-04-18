package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/kyley/argus/sidecar/internal/adapter"
	"github.com/kyley/argus/sidecar/internal/bus"
	"github.com/kyley/argus/sidecar/internal/config"
	"github.com/kyley/argus/sidecar/internal/protocol"
	"github.com/kyley/argus/sidecar/internal/sidecarlink"
	"github.com/kyley/argus/sidecar/internal/terminal"
)

const (
	heartbeatInterval = 5 * time.Second
	readBlock         = 2 * time.Second
)

type Runner struct {
	cfg     *config.Config
	bus     *bus.Bus
	adapter adapter.Adapter
	log     *log.Logger

	cancels sync.Map // commandID → context.CancelFunc
	busy    int64
}

func New(ctx context.Context, cfg *config.Config, logger *log.Logger) (*Runner, error) {
	b, err := bus.Dial(ctx, cfg.Bus.URL)
	if err != nil {
		return nil, err
	}
	adapterCfg := map[string]any{}
	for k, v := range cfg.Adapter {
		adapterCfg[k] = v
	}
	if cfg.WorkingDir != "" {
		adapterCfg[adapter.WorkingDirKey] = cfg.WorkingDir
	}
	ad, err := adapter.New(cfg.Type, adapterCfg)
	if err != nil {
		_ = b.Close()
		return nil, fmt.Errorf("build adapter: %w", err)
	}
	if err := ad.Ping(ctx); err != nil {
		logger.Printf("adapter ping failed: %v (will keep running)", err)
	}

	// Auto-detect the wrapped CLI's version when the YAML didn't pin one.
	// An explicit cfg.Version wins so operators have an escape hatch for
	// CLIs with a funky `--version` format (or when version detection
	// times out on a slow box).
	if cfg.Version == "" {
		if v, ok := ad.(adapter.Versioned); ok {
			if detected, err := v.Version(ctx); err == nil && detected != "" {
				cfg.Version = detected
				logger.Printf("detected %s version: %s", cfg.Type, detected)
			} else if err != nil {
				logger.Printf("version detection failed: %v", err)
			}
		}
		if cfg.Version == "" {
			cfg.Version = "unknown"
		}
	}

	return &Runner{
		cfg:     cfg,
		bus:     b,
		adapter: ad,
		log:     logger,
	}, nil
}

func (r *Runner) Run(ctx context.Context) error {
	if err := r.register(ctx); err != nil {
		return fmt.Errorf("register: %w", err)
	}

	cmdStream := protocol.CommandStream(r.cfg.ID)
	group := protocol.SidecarConsumerGroup(r.cfg.ID)
	if err := r.bus.EnsureGroup(ctx, cmdStream, group); err != nil {
		return fmt.Errorf("ensure group: %w", err)
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		r.heartbeatLoop(ctx)
	}()

	if r.cfg.Terminal.Enabled {
		// Terminal traffic rides the direct sidecar↔server link, not
		// Redis. Spin up the link first so the runner has a channel
		// to consume from immediately; it can tolerate the link
		// being disconnected (control frames just queue on the
		// server side until a sidecar reconnects and re-opens).
		link := sidecarlink.New(r.cfg.Server.URL, r.cfg.Server.Token, r.cfg.ID, r.log)
		wg.Add(1)
		go func() {
			defer wg.Done()
			link.Run(ctx)
		}()
		termRunner := terminal.New(r.cfg, link, r.log)
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := termRunner.Run(ctx); err != nil {
				r.log.Printf("terminal runner error: %v", err)
			}
		}()
	}

	consumer := "c-" + shortID()
	r.log.Printf("ready id=%s type=%s machine=%s", r.cfg.ID, r.cfg.Type, r.cfg.Machine)

	for {
		if ctx.Err() != nil {
			break
		}
		msgID, payload, err := r.bus.ReadMessage(ctx, cmdStream, group, consumer, readBlock)
		if errors.Is(err, context.Canceled) {
			break
		}
		if err != nil {
			r.log.Printf("read error: %v", err)
			time.Sleep(time.Second)
			continue
		}
		if msgID == "" {
			continue
		}

		cmd, err := decodeCommand(payload)
		if err != nil {
			r.log.Printf("decode command failed: %v", err)
			_ = r.bus.Ack(ctx, cmdStream, group, msgID)
			continue
		}

		if cmd.Kind == "cancel" {
			if c, ok := r.cancels.Load(cmd.ID); ok {
				c.(context.CancelFunc)()
			}
			_ = r.adapter.Cancel(ctx, cmd.ID)
			_ = r.bus.Ack(ctx, cmdStream, group, msgID)
			continue
		}

		wg.Add(1)
		go func(c protocol.Command, id string) {
			defer wg.Done()
			r.handleCommand(ctx, c)
			_ = r.bus.Ack(ctx, cmdStream, group, id)
		}(cmd, msgID)
	}

	// Graceful shutdown.
	shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = r.bus.Publish(shutdown, protocol.LifecycleStream(), protocol.DeregisterEvent{
		Kind: "deregister",
		ID:   r.cfg.ID,
		TS:   time.Now().UnixMilli(),
	})

	wg.Wait()
	return r.bus.Close()
}

func (r *Runner) register(ctx context.Context) error {
	return r.bus.Publish(ctx, protocol.LifecycleStream(), protocol.RegisterEvent{
		Kind:             "register",
		ID:               r.cfg.ID,
		Type:             r.cfg.Type,
		Machine:          r.cfg.Machine,
		SupportsTerminal: r.cfg.Terminal.Enabled,
		Version:          r.cfg.Version,
		WorkingDir:       r.cfg.WorkingDir,
		TS:               time.Now().UnixMilli(),
	})
}

func (r *Runner) heartbeatLoop(ctx context.Context) {
	t := time.NewTicker(heartbeatInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			status := protocol.StatusOnline
			if atomic.LoadInt64(&r.busy) > 0 {
				status = protocol.StatusBusy
			}
			err := r.bus.Publish(ctx, protocol.LifecycleStream(), protocol.HeartbeatEvent{
				Kind:   "heartbeat",
				ID:     r.cfg.ID,
				Status: status,
				TS:     time.Now().UnixMilli(),
			})
			if err != nil {
				r.log.Printf("heartbeat publish failed: %v", err)
			}
		}
	}
}

func (r *Runner) handleCommand(parent context.Context, cmd protocol.Command) {
	cmdCtx, cancel := context.WithCancel(parent)
	defer cancel()
	r.cancels.Store(cmd.ID, cancel)
	defer r.cancels.Delete(cmd.ID)
	atomic.AddInt64(&r.busy, 1)
	defer atomic.AddInt64(&r.busy, -1)

	resultStream := protocol.ResultStream(r.cfg.ID)
	seq := 0
	publishExternalIDOnce := false

	chunks, err := r.adapter.Execute(cmdCtx, cmd)
	if err != nil {
		seq++
		_ = r.bus.Publish(parent, resultStream, protocol.ResultChunk{
			ID:        uuid.NewString(),
			CommandID: cmd.ID,
			AgentID:   r.cfg.ID,
			SessionID: cmd.SessionID,
			Seq:       seq,
			Kind:      protocol.KindError,
			Content:   err.Error(),
			TS:        time.Now().UnixMilli(),
			IsFinal:   true,
		})
		return
	}

	for c := range chunks {
		if !publishExternalIDOnce && c.ExternalID != "" {
			publishExternalIDOnce = true
			_ = r.bus.Publish(parent, resultStream, protocol.SessionExternalIDEvent{
				Kind:       "session-external-id",
				SessionID:  cmd.SessionID,
				CommandID:  cmd.ID,
				ExternalID: c.ExternalID,
				TS:         time.Now().UnixMilli(),
			})
		}
		seq++
		_ = r.bus.Publish(parent, resultStream, protocol.ResultChunk{
			ID:        uuid.NewString(),
			CommandID: cmd.ID,
			AgentID:   r.cfg.ID,
			SessionID: cmd.SessionID,
			Seq:       seq,
			Kind:      c.Kind,
			Delta:     c.Delta,
			Content:   c.Content,
			Meta:      c.Meta,
			TS:        time.Now().UnixMilli(),
			IsFinal:   c.IsFinal,
		})
	}
}

func decodeCommand(payload map[string]any) (protocol.Command, error) {
	b, err := json.Marshal(payload)
	if err != nil {
		return protocol.Command{}, err
	}
	var c protocol.Command
	if err := json.Unmarshal(b, &c); err != nil {
		return protocol.Command{}, err
	}
	return c, nil
}

func shortID() string {
	return uuid.NewString()[:8]
}
