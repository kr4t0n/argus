// Package adapter — Cursor CLI session cloning.
//
// Cursor stores its chat state in a SQLite content-addressed graph at
// `~/.cursor/chats/<md5(workspace_path)>/<chat-id>/store.db`. The
// schema is two tables:
//
//	meta(key TEXT PRIMARY KEY, value TEXT)
//	  - one row, key='0', value = hex-encoded JSON of
//	    {agentId, latestRootBlobId, name, createdAt, mode, ...}
//
//	blobs(id TEXT PRIMARY KEY, data BLOB)
//	  - id is the sha256 of data; entries are protobuf-flavored
//	    messages forming a Merkle DAG. The "root" referenced by
//	    meta.latestRootBlobId is itself a blob whose `field=1`
//	    entries (each a 32-byte hash) list the conversation history
//	    in order. The first 2 are shared workspace context; the rest
//	    are conversation blobs (user messages are JSON, others are
//	    intermediate state).
//
// Crucially, Cursor keeps EVERY historical root in the blobs table —
// each step (user prompt, each assistant block, each tool round trip)
// writes a new root blob, but old ones aren't garbage-collected. That
// gives us per-turn truncation almost for free: to fork at turn N we
// just point meta.latestRootBlobId at the historical root that
// captures the state with N user messages. We don't synthesize any
// new blobs — every blob the new chat references was produced by
// Cursor itself, so Cursor can resume it.
//
// What does NOT work, and why we tried it before:
//
// The earlier implementation copied
// `~/.cursor/projects/<slug>/agent-transcripts/<chat-id>/<chat-id>.jsonl`
// and renamed the inner UUID. That JSONL is a derived view (cursor
// regenerates it on resume from the SQLite), not the source of truth.
// Resuming with our minted UUID worked filesystem-wise but cursor
// looked up the chat-id against its on-disk graph, found nothing, and
// started a fresh conversation — overwriting our transcript copy in
// the process.
package adapter

import (
	"bytes"
	"context"
	"crypto/md5"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// CloneSession forks the agent's current Cursor CLI chat into a new
// chat with id `newID`. See file-level docs for the data model.
//
// turnIndex semantics:
//   - turnIndex <= 0 OR turnIndex >= total-turns-in-source: full clone
//     (latestRootBlobId is unchanged; the new chat sees the entire
//     prior conversation).
//   - 1 <= turnIndex < total: rewind latestRootBlobId to the historical
//     root with exactly turnIndex user messages and the most complete
//     trailing state (the largest field=1 count among such roots, so
//     the assistant's full response to that turn is preserved).
//
// Returns the new chat id. Failures roll back any partially-written
// dst directory so a retry starts clean.
func (a *CursorCLIAdapter) CloneSession(
	ctx context.Context, srcExternalID string, turnIndex int,
) (string, error) {
	if a.workingDir == "" {
		return "", fmtCloneError("cursor-cli", srcExternalID,
			errors.New("workingDir not set; cannot derive workspace hash"))
	}
	home, err := homeDir()
	if err != nil {
		return "", fmtCloneError("cursor-cli", srcExternalID, err)
	}
	srcDir := cursorChatDir(home, a.workingDir, srcExternalID)
	if _, err := os.Stat(filepath.Join(srcDir, "store.db")); err != nil {
		if os.IsNotExist(err) {
			return "", fmtCloneError("cursor-cli", srcExternalID, errCloneSrcNotFound)
		}
		return "", fmtCloneError("cursor-cli", srcExternalID, err)
	}

	newID := newSessionUUID()
	dstDir := cursorChatDir(home, a.workingDir, newID)
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return "", fmtCloneError("cursor-cli", srcExternalID, err)
	}
	rollback := func() { _ = os.RemoveAll(dstDir) }

	// Copy store.db plus any sibling WAL/SHM. Best-effort: an actively
	// written chat may have uncommitted WAL frames at the moment we
	// copy, but Cursor checkpoints WAL on resume, so a slight race is
	// acceptable for the fork case (the user wouldn't typically click
	// fork while the source is mid-stream).
	for _, name := range []string{"store.db", "store.db-wal", "store.db-shm"} {
		sp := filepath.Join(srcDir, name)
		st, err := os.Stat(sp)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			rollback()
			return "", fmtCloneError("cursor-cli", srcExternalID, err)
		}
		if !st.Mode().IsRegular() {
			continue
		}
		if err := copyRegularFile(sp, filepath.Join(dstDir, name)); err != nil {
			rollback()
			return "", fmtCloneError("cursor-cli", srcExternalID, err)
		}
	}

	if err := cursorPatchStoreDB(ctx, filepath.Join(dstDir, "store.db"), newID, turnIndex); err != nil {
		rollback()
		return "", fmtCloneError("cursor-cli", srcExternalID, err)
	}
	return newID, nil
}

// cursorChatDir returns the absolute path where Cursor stores chat
// state for (workspace, chatID). Cursor buckets by md5 of the
// workspace path verbatim — no normalization, no trailing slash
// trimming — so we mirror exactly.
func cursorChatDir(home, workspace, chatID string) string {
	h := md5.Sum([]byte(workspace))
	return filepath.Join(home, ".cursor", "chats", hex.EncodeToString(h[:]), chatID)
}

// cursorPatchStoreDB rewrites meta on the cloned store.db: agentId
// gets the new chat UUID, and (when turnIndex truncates the
// conversation) latestRootBlobId is rewound to a historical root
// captured by Cursor itself. No blob synthesis — all data the new
// chat references was already in the source.
func cursorPatchStoreDB(ctx context.Context, dstStorePath, newID string, turnIndex int) error {
	db, err := sql.Open("sqlite", dstStorePath)
	if err != nil {
		return fmt.Errorf("open clone db: %w", err)
	}
	defer db.Close()

	var hexValue string
	if err := db.QueryRowContext(ctx, "SELECT value FROM meta WHERE key='0'").Scan(&hexValue); err != nil {
		return fmt.Errorf("read meta: %w", err)
	}
	raw, err := hex.DecodeString(hexValue)
	if err != nil {
		return fmt.Errorf("decode meta hex: %w", err)
	}
	var meta map[string]any
	if err := json.Unmarshal(raw, &meta); err != nil {
		return fmt.Errorf("decode meta json: %w", err)
	}

	meta["agentId"] = newID

	if turnIndex > 0 {
		currentRootID, _ := meta["latestRootBlobId"].(string)
		forkRoot, err := cursorFindForkRoot(ctx, db, currentRootID, turnIndex)
		if err != nil {
			return err
		}
		// Empty forkRoot means "no truncation needed" — turnIndex was
		// at or past the source's total turn count, so we keep
		// latestRootBlobId pointing at the head.
		if forkRoot != "" {
			meta["latestRootBlobId"] = forkRoot
		}
	}

	newJSON, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("encode meta json: %w", err)
	}
	if _, err := db.ExecContext(ctx,
		"UPDATE meta SET value = ? WHERE key = '0'",
		hex.EncodeToString(newJSON),
	); err != nil {
		return fmt.Errorf("update meta: %w", err)
	}
	return nil
}

// cursorFindForkRoot scans the blobs table for "root-like" snapshots
// (heuristic: top-level field=1 hashes plus a field=9 'file://'
// workspace URL — the same shape Cursor uses for chat roots) and
// picks the historical root with exactly `turnIndex` user messages
// among its top-level field=1 children. When several roots have the
// same user-message count (Cursor writes pairs of snapshots —
// pre-tool-call and post-tool-call), we pick the one with the largest
// field=1 count, which captures the assistant's most complete
// response state for that turn.
//
// Returns ("", nil) when turnIndex is at or past the source's total
// turn count — the caller treats that as "no truncation needed,
// keep the head root." Returns an error if the source genuinely has
// turnIndex turns but we can't find a snapshot for it (Cursor
// shouldn't ever GC its own roots, so this would indicate a corrupt
// source we'd rather fail loudly on).
func cursorFindForkRoot(ctx context.Context, db *sql.DB, currentRootID string, turnIndex int) (string, error) {
	currentRoot, err := loadBlob(ctx, db, currentRootID)
	if err != nil {
		return "", fmt.Errorf("load current root: %w", err)
	}
	if currentRoot == nil {
		return "", fmt.Errorf("current root %s missing from blobs", currentRootID)
	}
	totalTurns, err := countUserMessagesInRoot(ctx, db, currentRoot)
	if err != nil {
		return "", fmt.Errorf("count current-root user messages: %w", err)
	}
	if turnIndex >= totalTurns {
		// Caller should fall through to full clone (no rewind).
		return "", nil
	}

	rows, err := db.QueryContext(ctx, "SELECT id, data FROM blobs")
	if err != nil {
		return "", fmt.Errorf("scan blobs: %w", err)
	}
	defer rows.Close()

	bestID := ""
	bestF1 := -1
	for rows.Next() {
		var id string
		var data []byte
		if err := rows.Scan(&id, &data); err != nil {
			return "", err
		}
		if !cursorIsRootLikeBlob(data) {
			continue
		}
		userMsgs, err := countUserMessagesInRoot(ctx, db, data)
		if err != nil {
			// Don't abort the whole scan over one weird blob.
			continue
		}
		if userMsgs != turnIndex {
			continue
		}
		f1 := cursorCountTopLevelField1(data)
		if f1 > bestF1 {
			bestF1 = f1
			bestID = id
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if bestID == "" {
		return "", fmt.Errorf(
			"no historical root with %d user message(s) found in source chat",
			turnIndex,
		)
	}
	return bestID, nil
}

// loadBlob reads one blob by id; returns (nil, nil) when absent.
func loadBlob(ctx context.Context, db *sql.DB, id string) ([]byte, error) {
	var data []byte
	err := db.QueryRowContext(ctx, "SELECT data FROM blobs WHERE id = ?", id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return data, err
}

// countUserMessagesInRoot decodes a root blob's top-level field=1
// hashes, dereferences each, and counts how many target blobs are
// user-message JSONs (start with `{"role":"user"`). The first 2 hashes
// in every root we observed are shared workspace context blobs (not
// user messages), so the count comes purely from conversation entries.
func countUserMessagesInRoot(ctx context.Context, db *sql.DB, root []byte) (int, error) {
	hashes := cursorTopLevelField1Hashes(root)
	n := 0
	for _, h := range hashes {
		blob, err := loadBlob(ctx, db, h)
		if err != nil {
			return 0, err
		}
		if isCursorUserMessage(blob) {
			n++
		}
	}
	return n, nil
}

// isCursorUserMessage reports whether a blob is a real user-prompt
// turn boundary. Cursor stores three different `role:"user"` blob
// shapes — only one of them is an actual prompt:
//
//	{"role":"user","content":[{"type":"text","text":"<timestamp>...<user_query>..."}]}
//	  ↑ real prompt: contains <timestamp> wrapper
//	{"role":"user","content":"<user_info>OS Version: ..."}
//	  ↑ workspace context blob (one shared across all chats)
//	{"role":"user","content":[{"type":"text","text":"\n<system_reminder>...<user_query>..."}]}
//	  ↑ injected reminder (no <timestamp>); cursor adds these
//	    transparently, NOT counted as a user-driven turn
//
// Counting on the `<timestamp>` substring matches exactly the real
// prompts and excludes the other two — verified across the three
// sample dbs (3210/ca0c/e81c, with 3/1/2 real prompts respectively).
func isCursorUserMessage(b []byte) bool {
	const rolePrefix = `{"role":"user"`
	if len(b) < len(rolePrefix) || string(b[:len(rolePrefix)]) != rolePrefix {
		return false
	}
	return bytes.Contains(b, []byte("<timestamp>"))
}

// cursorIsRootLikeBlob applies the heuristic that catches every chat
// root snapshot in a Cursor store.db: at least 2 top-level field=1
// hash entries (conversation refs) AND a field=9 entry whose value
// starts with "file://" (the workspace URL Cursor stamps into every
// root). The shared-context blobs and individual message blobs both
// fail this test; only roots pass.
func cursorIsRootLikeBlob(b []byte) bool {
	f1 := 0
	hasFileURL := false
	i := 0
	for i < len(b) {
		tag, i2, ok := readVarintByte(b, i)
		if !ok {
			return false
		}
		i = i2
		field := tag >> 3
		wire := tag & 7
		switch wire {
		case 0: // varint
			_, ni, ok := readVarintInt(b, i)
			if !ok {
				return false
			}
			i = ni
		case 1: // fixed64
			if i+8 > len(b) {
				return false
			}
			i += 8
		case 2: // length-delimited
			ln, ni, ok := readVarintInt(b, i)
			if !ok {
				return false
			}
			i = ni
			if ln < 0 || i+ln > len(b) {
				return false
			}
			chunk := b[i : i+ln]
			i += ln
			if field == 1 && ln == 32 {
				f1++
			}
			if field == 9 && ln >= 7 && string(chunk[:7]) == "file://" {
				hasFileURL = true
			}
		case 5: // fixed32
			if i+4 > len(b) {
				return false
			}
			i += 4
		default:
			// Wire type 3 (start group, deprecated) — bail out on the
			// truthy check we have so far. Cursor's roots use it only
			// in trailing metadata fields, after all the field=1 + 9
			// entries we care about.
			return f1 >= 2 && hasFileURL
		}
	}
	return f1 >= 2 && hasFileURL
}

// cursorCountTopLevelField1 returns the number of top-level field=1
// entries in a blob (used to break ties when multiple roots share a
// user-message count).
func cursorCountTopLevelField1(b []byte) int {
	n := 0
	i := 0
	for i < len(b) {
		tag, ni, ok := readVarintByte(b, i)
		if !ok {
			return n
		}
		i = ni
		field := tag >> 3
		wire := tag & 7
		switch wire {
		case 0:
			_, ni, ok := readVarintInt(b, i)
			if !ok {
				return n
			}
			i = ni
		case 1:
			if i+8 > len(b) {
				return n
			}
			i += 8
		case 2:
			ln, ni, ok := readVarintInt(b, i)
			if !ok {
				return n
			}
			i = ni
			if ln < 0 || i+ln > len(b) {
				return n
			}
			if field == 1 {
				n++
			}
			i += ln
		case 5:
			if i+4 > len(b) {
				return n
			}
			i += 4
		default:
			return n
		}
	}
	return n
}

// cursorTopLevelField1Hashes returns the 32-byte field=1 entries
// (decoded as hex strings to match how they're stored as blob ids).
func cursorTopLevelField1Hashes(b []byte) []string {
	out := make([]string, 0, 8)
	i := 0
	for i < len(b) {
		tag, ni, ok := readVarintByte(b, i)
		if !ok {
			return out
		}
		i = ni
		field := tag >> 3
		wire := tag & 7
		switch wire {
		case 0:
			_, ni, ok := readVarintInt(b, i)
			if !ok {
				return out
			}
			i = ni
		case 1:
			if i+8 > len(b) {
				return out
			}
			i += 8
		case 2:
			ln, ni, ok := readVarintInt(b, i)
			if !ok {
				return out
			}
			i = ni
			if ln < 0 || i+ln > len(b) {
				return out
			}
			if field == 1 && ln == 32 {
				out = append(out, hex.EncodeToString(b[i:i+ln]))
			}
			i += ln
		case 5:
			if i+4 > len(b) {
				return out
			}
			i += 4
		default:
			return out
		}
	}
	return out
}

// readVarintByte reads ONE byte at b[i] (the protobuf tag byte; tags
// are themselves varints but in practice always fit in one byte for
// the field numbers Cursor uses). Returns the value, the next read
// offset, and ok=false on EOF.
func readVarintByte(b []byte, i int) (int, int, bool) {
	if i >= len(b) {
		return 0, i, false
	}
	return int(b[i]), i + 1, true
}

// readVarintInt decodes a multi-byte varint at b[i:]. Returns
// (value, next-offset, ok). Bounded at 10 bytes (max varint length)
// to avoid pathological inputs spinning forever.
func readVarintInt(b []byte, i int) (int, int, bool) {
	v := 0
	shift := uint(0)
	for k := 0; k < 10 && i < len(b); k++ {
		x := int(b[i])
		i++
		v |= (x & 0x7f) << shift
		if x&0x80 == 0 {
			return v, i, true
		}
		shift += 7
	}
	return 0, i, false
}

// copyRegularFile copies src to dst preserving mode bits. Used for the
// store.db / store.db-wal / store.db-shm trio in chat dirs — chat
// dirs are otherwise flat, so a recursive copy isn't worth the
// complexity.
func copyRegularFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, st.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}
