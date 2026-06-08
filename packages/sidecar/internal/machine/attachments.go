package machine

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// uploadsSubdir is where pulled attachments land, relative to the agent's
// workingDir. Kept under .argus/ so the file-tree walker and gitignore
// stripping already hide it (see fs.go's hard-skip of .argus/), and it
// sits beside .argus/progress.
const uploadsSubdir = ".argus/uploads"

// attachmentSizeCeiling bounds a pull whose ref declares no size — a
// safety net so a misbehaving/hostile server can't fill the agent's disk.
const attachmentSizeCeiling int64 = 64 << 20 // 64 MiB

// materializeAttachments pulls every file referenced by cmd.Attachments
// from the server over HTTP, writes it under the agent's
// <workingDir>/.argus/uploads/, records the on-disk path on each ref, and
// appends a uniform "attached files" preamble to the prompt so EVERY
// adapter (and the model) can reference the files by path. Adapters with a
// native image flag (codex --image) additionally consume ref.LocalPath.
//
// Fail-soft, per file: a single failed pull is logged and skipped rather
// than failing the whole turn — the model still gets the prompt plus
// whatever files did land. Mutates *cmd in place.
func (s *supervisor) materializeAttachments(ctx context.Context, cmd *protocol.Command) {
	if len(cmd.Attachments) == 0 {
		return
	}
	if s.serverURL == "" || s.httpClient == nil {
		s.log.Printf("agent %s: %d attachment(s) but no server link configured; skipping",
			s.spec.AgentID, len(cmd.Attachments))
		return
	}

	dir := s.uploadsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		s.log.Printf("agent %s: create uploads dir %q: %v", s.spec.AgentID, dir, err)
		return
	}

	landed := 0
	for i := range cmd.Attachments {
		ref := &cmd.Attachments[i]
		path, err := s.pullAttachment(ctx, dir, ref)
		if err != nil {
			s.log.Printf("agent %s: pull attachment %s (%s): %v",
				s.spec.AgentID, ref.ID, ref.Filename, err)
			continue
		}
		ref.LocalPath = path
		landed++
	}
	if landed > 0 {
		cmd.Prompt = appendAttachmentPreamble(cmd.Prompt, cmd.Attachments)
	}
}

// uploadsDir resolves the directory pulled files land in. For an agent
// with a workingDir it's <workingDir>/.argus/uploads; for a working-dir-
// less agent we fall back to a per-agent temp dir so the feature still
// works (the CLI just gets an absolute path).
func (s *supervisor) uploadsDir() string {
	base := s.spec.WorkingDir
	if base == "" {
		return filepath.Join(os.TempDir(), "argus-uploads", s.spec.AgentID)
	}
	return filepath.Join(base, uploadsSubdir)
}

// pullAttachment GETs one attachment from the server and writes it into
// dir, returning the absolute path written. The copy is bounded to the
// ref's declared size (plus one byte to detect overflow) so a misbehaving
// server can't fill the disk.
func (s *supervisor) pullAttachment(
	ctx context.Context, dir string, ref *protocol.AttachmentRef,
) (string, error) {
	endpoint := fmt.Sprintf("%s/attachments/%s?t=%s",
		strings.TrimRight(s.serverURL, "/"),
		url.PathEscape(ref.ID),
		url.QueryEscape(ref.Token),
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("server returned %s", resp.Status)
	}

	limit := attachmentSizeCeiling
	if ref.Size > 0 {
		limit = ref.Size
	}

	dst := filepath.Join(dir, safeAttachmentFilename(ref.ID, ref.Filename))
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return "", err
	}
	n, copyErr := io.Copy(f, io.LimitReader(resp.Body, limit+1))
	closeErr := f.Close()
	if copyErr != nil {
		_ = os.Remove(dst)
		return "", copyErr
	}
	if closeErr != nil {
		_ = os.Remove(dst)
		return "", closeErr
	}
	if n > limit {
		_ = os.Remove(dst)
		return "", fmt.Errorf("body exceeded the %d-byte bound", limit)
	}

	if abs, err := filepath.Abs(dst); err == nil {
		return abs, nil
	}
	return dst, nil
}

// appendAttachmentPreamble appends a uniform, path-listing block to the
// prompt for every attachment that successfully landed (LocalPath set).
// This is the cross-adapter floor: Claude and Cursor attach an image as
// vision when its path is mentioned in the prompt, and every agent can
// open a non-image file it's told the path of. Codex additionally gets
// images via --image, but listing them here too is harmless context.
func appendAttachmentPreamble(prompt string, refs []protocol.AttachmentRef) string {
	var b strings.Builder
	b.WriteString(prompt)
	wrote := false
	for _, r := range refs {
		if r.LocalPath == "" {
			continue
		}
		if !wrote {
			if prompt != "" {
				b.WriteString("\n\n")
			}
			b.WriteString("The user attached the following file(s), already saved on disk:\n")
			wrote = true
		}
		fmt.Fprintf(&b, "- %s (%s)\n", r.LocalPath, r.Mime)
	}
	return b.String()
}

// safeAttachmentFilename builds a collision-free, path-safe on-disk name:
// the attachment id (a cuid, filesystem-safe) prefixes a sanitized form of
// the client filename. Defense-in-depth — the server sanitizes too, but
// this is the code actually writing to the agent's disk.
func safeAttachmentFilename(id, filename string) string {
	base := filename
	if i := strings.LastIndexAny(base, `/\`); i >= 0 {
		base = base[i+1:]
	}
	cleaned := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' {
			return -1
		}
		return r
	}, base)
	cleaned = strings.TrimLeft(cleaned, ".")
	if len(cleaned) > 128 {
		cleaned = cleaned[:128]
	}
	if cleaned == "" {
		cleaned = "file"
	}
	return id + "-" + cleaned
}
