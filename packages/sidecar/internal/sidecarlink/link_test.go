// Tests for the link's proxy support. The link dials through
// HTTP_PROXY / HTTPS_PROXY like the sidecar's HTTP clients do; before
// it did, a host that can only reach the server through a proxy got a
// working machine with no terminal.
package sidecarlink

import (
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/kr4t0n/argus/sidecar/internal/protocol"
)

// withProxy replaces the environment lookup for the duration of the
// test. net/http never proxies loopback, so the env path can't reach a
// local proxy.
func withProxy(t *testing.T, proxy *url.URL) {
	t.Helper()
	orig := proxyFromEnvironment
	proxyFromEnvironment = func(*http.Request) (*url.URL, error) { return proxy, nil }
	t.Cleanup(func() { proxyFromEnvironment = orig })
}

// linkServer answers the hello handshake and then holds the socket open
// until the client goes away.
func linkServer(t *testing.T) *httptest.Server {
	t.Helper()
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var hello protocol.SidecarHello
		if err := conn.ReadJSON(&hello); err != nil {
			return
		}
		_ = conn.WriteJSON(protocol.SidecarHelloAck{Kind: protocol.LinkKindHelloAck, IdleTimeoutMS: 45000})
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// connectProxy is a minimal HTTP CONNECT proxy. Every tunnel target is
// reported on the returned channel.
func connectProxy(t *testing.T) (*httptest.Server, <-chan string) {
	t.Helper()
	targets := make(chan string, 8)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "CONNECT only", http.StatusMethodNotAllowed)
			return
		}
		targets <- r.Host
		upstream, err := net.Dial("tcp", r.Host)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		client, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		_, _ = client.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
		go func() {
			_, _ = io.Copy(upstream, buf.Reader)
			upstream.Close()
		}()
		_, _ = io.Copy(client, upstream)
		client.Close()
	}))
	t.Cleanup(srv.Close)
	return srv, targets
}

func TestLinkDialsThroughProxy(t *testing.T) {
	server := linkServer(t)
	proxy, targets := connectProxy(t)
	proxyURL, _ := url.Parse(proxy.URL)
	withProxy(t, proxyURL)

	c := New(server.URL, "s3cret", "sidecar-1", log.New(io.Discard, "", 0))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		c.Run(ctx)
		close(done)
	}()
	// Registered after withProxy, so it runs first: Run must be gone
	// before the proxy lookup is restored.
	t.Cleanup(func() {
		cancel()
		<-done
	})

	deadline := time.Now().Add(5 * time.Second)
	for !c.IsConnected() {
		if time.Now().After(deadline) {
			t.Fatal("link never connected through the proxy")
		}
		time.Sleep(10 * time.Millisecond)
	}

	serverHost := strings.TrimPrefix(server.URL, "http://")
	select {
	case got := <-targets:
		if got != serverHost {
			t.Fatalf("proxy tunnelled to %q, want %q", got, serverHost)
		}
	default:
		t.Fatal("link connected without going through the proxy")
	}
}

// An https:// proxy URL is valid for net/http but not for gorilla. The
// error has to name the proxy, or the operator only sees the dial fail,
// and must not leak the link token or the proxy password into the log.
func TestLinkDialErrorNamesProxyAndHidesSecrets(t *testing.T) {
	withProxy(t, &url.URL{Scheme: "https", User: url.UserPassword("u", "p4ss"), Host: "proxy.invalid:3128"})

	c := New("http://argus.invalid:4000", "s3cret", "sidecar-1", log.New(io.Discard, "", 0))
	err := c.dialAndServe(context.Background())
	if err == nil {
		t.Fatal("dial through an https:// proxy succeeded; expected gorilla to reject the scheme")
	}
	msg := err.Error()
	for _, want := range []string{"via proxy https://u:xxxxx@proxy.invalid:3128", "unknown scheme: https", "token=redacted"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not contain %q", msg, want)
		}
	}
	for _, secret := range []string{"s3cret", "p4ss"} {
		if strings.Contains(msg, secret) {
			t.Errorf("error %q leaks %q", msg, secret)
		}
	}
}
