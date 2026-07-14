package machine

import (
	"context"
	"log"
	"time"

	"github.com/kr4t0n/argus/sidecar/internal/bus"
	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// Workdir-addressed serving for the fs-list / fs-read / git-log RPCs
// (Phase 2 of docs/plan-agent-to-runners.md). These are the shared
// bodies behind both addressing modes: the supervisor Handle* methods
// delegate here with their spec's workingDir (legacy agent-addressed
// requests), and the daemon calls them directly for requests that
// carry an explicit `workingDir` — after validating it against the
// machine's known-workdirs allowlist, so a buggy or compromised
// server can't list arbitrary paths (see plan §4.3).
//
// `agentID` is attribution only: responses echo whatever id the
// request carried (possibly empty for project-addressed requests) —
// the server's pending map is keyed by RequestID alone.

func serveFSList(
	ctx context.Context,
	b *bus.Bus,
	logger *log.Logger,
	machineID, agentID, workingDir string,
	req protocol.FSListRequestCommand,
) {
	resp := protocol.FSListResponseEvent{
		Kind:      "fs-list-response",
		MachineID: machineID,
		AgentID:   agentID,
		RequestID: req.RequestID,
		Path:      req.Path,
		TS:        time.Now().UnixMilli(),
	}

	depth := req.Depth
	if depth < 1 {
		depth = 1
	}
	// Match ListDirs' root-path normalization so the root-listing
	// lookup below hits the canonical "" key it produces.
	rootKey := req.Path
	if rootKey == "." {
		rootKey = ""
	}
	listings, err := ListDirs(ListDirRequest{
		WorkingDir: workingDir,
		Path:       req.Path,
		ShowAll:    req.ShowAll,
	}, depth, protocol.FSListRecursiveDescentBudget)

	if err != nil {
		resp.Error = err.Error()
	} else {
		if depth > 1 {
			resp.Listings = make(map[string][]protocol.FSEntry, len(listings))
		}
		for path, entries := range listings {
			pe := toProtocolEntries(entries)
			if path == rootKey {
				resp.Entries = pe
			}
			if depth > 1 {
				resp.Listings[path] = pe
			}
		}
		// Best-effort GitStatus; non-repo workingDirs no-op silently.
		if git, gerr := ReadGitStatus(workingDir); gerr == nil && git != nil {
			resp.Git = git
		} else if gerr != nil {
			logger.Printf("fs-list %s: read git status: %v", workingDir, gerr)
		}
	}

	if err := b.Publish(ctx, protocol.LifecycleStream(), resp); err != nil {
		logger.Printf("fs-list-response publish failed: %v", err)
	}
}

func serveFSRead(
	ctx context.Context,
	b *bus.Bus,
	logger *log.Logger,
	machineID, agentID, workingDir string,
	req protocol.FSReadRequestCommand,
) {
	res, err := ReadFile(ReadFileRequest{
		WorkingDir: workingDir,
		Path:       req.Path,
		MaxBytes:   protocol.FSReadMaxBytes,
	})
	resp := protocol.FSReadResponseEvent{
		Kind:      "fs-read-response",
		MachineID: machineID,
		AgentID:   agentID,
		RequestID: req.RequestID,
		Path:      req.Path,
		TS:        time.Now().UnixMilli(),
	}
	if err != nil {
		resp.Result = "error"
		resp.Error = err.Error()
	} else {
		resp.Result = res.Result
		resp.Content = res.Content
		resp.MIME = res.MIME
		resp.Base64 = res.Base64
		resp.Size = res.Size
		resp.Error = res.Error
	}
	if err := b.Publish(ctx, protocol.LifecycleStream(), resp); err != nil {
		logger.Printf("fs-read-response publish failed: %v", err)
	}
}

func serveGitLog(
	ctx context.Context,
	b *bus.Bus,
	logger *log.Logger,
	machineID, agentID, workingDir string,
	req protocol.GitLogRequestCommand,
) {
	resp := protocol.GitLogResponseEvent{
		Kind:      "git-log-response",
		MachineID: machineID,
		AgentID:   agentID,
		RequestID: req.RequestID,
		TS:        time.Now().UnixMilli(),
	}
	commits, err := ReadGitLog(ctx, workingDir, req.Limit)
	if err != nil {
		resp.Error = err.Error()
	} else {
		// commits == nil ⇒ non-repo workingDir. The server treats nil
		// the same as an empty list at the controller layer, so callers
		// see "no commits" rather than an error — keeps the panel
		// flicker-free if the user toggles into a non-repo dir.
		resp.Commits = commits
	}
	// Attach GitStatus regardless — even when the log read failed, the
	// panel header might still want the current branch. Cheap: one
	// .git/HEAD read.
	if status, gerr := ReadGitStatus(workingDir); gerr == nil && status != nil {
		resp.Git = status
	}
	if err := b.Publish(ctx, protocol.LifecycleStream(), resp); err != nil {
		logger.Printf("git-log-response publish failed: %v", err)
	}
}
