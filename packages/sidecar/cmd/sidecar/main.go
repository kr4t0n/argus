package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/kyley/argus/sidecar/internal/adapter"
	"github.com/kyley/argus/sidecar/internal/config"
	"github.com/kyley/argus/sidecar/internal/lifecycle"
)

func main() {
	var (
		cfgPath        = flag.String("config", "sidecar.yaml", "path to sidecar config")
		listAdapters   = flag.Bool("list-adapters", false, "print registered adapter types and exit")
	)
	flag.Parse()

	if *listAdapters {
		fmt.Println(strings.Join(adapter.Types(), "\n"))
		return
	}

	logger := log.New(os.Stderr, "[argus-sidecar] ", log.LstdFlags|log.Lmicroseconds)

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		logger.Fatalf("load config: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		s := <-sigs
		logger.Printf("received %s, shutting down", s)
		cancel()
	}()

	r, err := lifecycle.New(ctx, cfg, logger)
	if err != nil {
		logger.Fatalf("init runner: %v", err)
	}
	if err := r.Run(ctx); err != nil && err != context.Canceled {
		logger.Fatalf("runner: %v", err)
	}
	logger.Println("bye")
}
