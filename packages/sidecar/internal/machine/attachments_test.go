package machine

import (
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

func TestSafeAttachmentFilename(t *testing.T) {
	cases := []struct {
		name     string
		id       string
		filename string
		want     string
	}{
		{"plain", "abc123", "diagram.png", "abc123-diagram.png"},
		{"strips dir", "abc123", "sub/dir/photo.jpg", "abc123-photo.jpg"},
		{"path traversal", "abc123", "../../etc/passwd", "abc123-passwd"},
		{"backslash traversal", "abc123", `..\..\windows\system32`, "abc123-system32"},
		{"leading dots", "abc123", "...hidden", "abc123-hidden"},
		{"control chars", "abc123", "a\x00b\x1fc.txt", "abc123-abc.txt"},
		{"empty falls back", "abc123", "", "abc123-file"},
		{"only separators", "abc123", "/", "abc123-file"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := safeAttachmentFilename(tc.id, tc.filename)
			if got != tc.want {
				t.Fatalf("safeAttachmentFilename(%q,%q)=%q want %q", tc.id, tc.filename, got, tc.want)
			}
			if strings.ContainsAny(got, `/\`) {
				t.Fatalf("result %q must not contain path separators", got)
			}
		})
	}
}

func TestAppendAttachmentPreamble(t *testing.T) {
	t.Run("no landed files leaves prompt untouched", func(t *testing.T) {
		refs := []protocol.AttachmentRef{{ID: "a", Filename: "x.png", Mime: "image/png"}} // no LocalPath
		got := appendAttachmentPreamble("hello", refs)
		if got != "hello" {
			t.Fatalf("expected unchanged prompt, got %q", got)
		}
	})

	t.Run("lists only landed files after the prompt", func(t *testing.T) {
		refs := []protocol.AttachmentRef{
			{ID: "a", Filename: "x.png", Mime: "image/png", LocalPath: "/w/.argus/uploads/a-x.png"},
			{ID: "b", Filename: "y.csv", Mime: "text/csv"}, // not landed → omitted
			{ID: "c", Filename: "z.pdf", Mime: "application/pdf", LocalPath: "/w/.argus/uploads/c-z.pdf"},
		}
		got := appendAttachmentPreamble("look at these", refs)
		if !strings.HasPrefix(got, "look at these\n\n") {
			t.Fatalf("preamble should follow the prompt, got %q", got)
		}
		if !strings.Contains(got, "/w/.argus/uploads/a-x.png (image/png)") {
			t.Fatalf("missing landed image path, got %q", got)
		}
		if !strings.Contains(got, "/w/.argus/uploads/c-z.pdf (application/pdf)") {
			t.Fatalf("missing landed pdf path, got %q", got)
		}
		if strings.Contains(got, "y.csv") {
			t.Fatalf("un-landed file should be omitted, got %q", got)
		}
	})

	t.Run("empty prompt has no leading blank lines", func(t *testing.T) {
		refs := []protocol.AttachmentRef{{ID: "a", Filename: "x.png", Mime: "image/png", LocalPath: "/p/a-x.png"}}
		got := appendAttachmentPreamble("", refs)
		if strings.HasPrefix(got, "\n") {
			t.Fatalf("empty prompt should not start with a newline, got %q", got)
		}
	})
}

func newTestSupervisor() *supervisor {
	return &supervisor{
		spec:       AgentRecord{AgentID: "agent-test"},
		log:        log.New(io.Discard, "", 0),
		httpClient: &http.Client{},
	}
}

func TestPullAttachmentWritesFile(t *testing.T) {
	body := []byte("the quick brown fox")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/attachments/att-1" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if r.URL.Query().Get("t") != "tok-xyz" {
			t.Errorf("missing/incorrect token: %q", r.URL.Query().Get("t"))
		}
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	s := newTestSupervisor()
	s.serverURL = srv.URL
	dir := t.TempDir()
	ref := &protocol.AttachmentRef{ID: "att-1", Filename: "fox.txt", Mime: "text/plain", Size: int64(len(body)), Token: "tok-xyz"}

	path, err := s.pullAttachment(context.Background(), dir, ref)
	if err != nil {
		t.Fatalf("pullAttachment: %v", err)
	}
	if filepath.Base(path) != "att-1-fox.txt" {
		t.Fatalf("unexpected filename %q", filepath.Base(path))
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read landed file: %v", err)
	}
	if string(got) != string(body) {
		t.Fatalf("content mismatch: got %q want %q", got, body)
	}
}

func TestPullAttachmentRejectsOversizeBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("way more bytes than declared"))
	}))
	defer srv.Close()

	s := newTestSupervisor()
	s.serverURL = srv.URL
	dir := t.TempDir()
	// Declare a tiny size; the server sends far more → guard must trip.
	ref := &protocol.AttachmentRef{ID: "att-2", Filename: "x.bin", Size: 3, Token: "t"}

	if _, err := s.pullAttachment(context.Background(), dir, ref); err == nil {
		t.Fatal("expected oversize body to be rejected")
	}
	// The partial file must have been cleaned up.
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("expected no files left behind, found %d", len(entries))
	}
}

func TestPullAttachmentServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	s := newTestSupervisor()
	s.serverURL = srv.URL
	ref := &protocol.AttachmentRef{ID: "att-3", Filename: "x", Size: 1, Token: "bad"}

	if _, err := s.pullAttachment(context.Background(), t.TempDir(), ref); err == nil {
		t.Fatal("expected non-200 to error")
	}
}
