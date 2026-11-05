// Package netproxy decides which proxy the plugin host's own requests to
// vendors go through: the one a provider or account set, else the usual
// *_PROXY variables, else the system's.
//
// It is part of magpie's internal/netproxy, kept for what the plugin host
// calls: a provider's own proxy, the Bun process the plugins run in, and the
// refusal that keeps work no one asked for from leaving the machine. The
// bridging of a SOCKS5 proxy onto loopback (which Bun needs, as it speaks
// http:// proxies only) is here in full, since a user with a SOCKS proxy is
// otherwise unable to run any plugin.
package netproxy

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
)

type choiceKey struct{}

type holdKey struct{}

var errHeld = errors.New("the plugin host was told not to send this request")

// Hold is ctx for work no one asked for and that must not be sent: no
// request made with it through a transport that honours this leaves the
// machine; each fails before it dials.
func Hold(ctx context.Context, err error) context.Context {
	if err == nil {
		err = errHeld
	}
	return context.WithValue(ctx, holdKey{}, err)
}

// Held is the error ctx holds its requests with, nil when it holds none.
func Held(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	err, _ := ctx.Value(holdKey{}).(error)
	return err
}

// With is ctx for requests made on behalf of one provider, whose own proxy
// is choice: "" follows the host's, "direct" goes through none, anything
// else is the proxy's address (http://, https://, socks5://; host:port means
// http).
func With(ctx context.Context, choice string) context.Context {
	choice = strings.TrimSpace(choice)
	if choice == "" && Choice(ctx) == "" {
		return ctx
	}
	return context.WithValue(ctx, choiceKey{}, choice)
}

// Choice is the proxy ctx names (With), "" when it names none.
func Choice(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	c, _ := ctx.Value(choiceKey{}).(string)
	return c
}

// Parse is a proxy choice as a URL: host:port means http, and a scheme the
// host can't use is refused here rather than by a vendor's timeout.
func Parse(s string) (*url.URL, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, errors.New("no proxy")
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return nil, err
	}
	switch u.Scheme {
	case "http", "https", "socks5", "socks5h":
	default:
		return nil, errors.New("a proxy is http://, https:// or socks5://")
	}
	if u.Host == "" {
		return nil, errors.New("a proxy needs a host")
	}
	return u, nil
}

// System is the proxy the machine's settings name, "" when none does. This
// build reads only the environment: a hub runs as a service, where the
// system's proxy is the environment's.
type Proxy struct {
	URL   string
	HTTP  string
	SOCKS string
}

func System() Proxy { return systemProxy() }

var sysOnce struct {
	sync.Once
	p Proxy
}

func systemProxy() Proxy {
	sysOnce.Do(func() {
		for _, k := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
			if v := strings.TrimSpace(os.Getenv(k)); v != "" {
				sysOnce.p.URL = v
				return
			}
		}
	})
	return sysOnce.p
}

// Env is env with the host's proxy choice told to a program it starts: the
// four variables a CLI reads, set from the choice or left as they are.
func Env(env []string) []string { return EnvWith("", env) }

// EnvWith is Env for one provider's choice (With's): "" keeps the
// environment's own.
func EnvWith(choice string, env []string) []string {
	choice = strings.TrimSpace(choice)
	if choice == "" {
		return env
	}
	out := make([]string, 0, len(env)+4)
	for _, e := range env {
		k, _, _ := strings.Cut(e, "=")
		switch strings.ToUpper(k) {
		case "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY":
			continue
		}
		out = append(out, e)
	}
	if choice == "direct" {
		out = append(out, "NO_PROXY=*", "no_proxy=*")
		return out
	}
	if u, err := Parse(choice); err == nil {
		a := u.String()
		out = append(out, "HTTPS_PROXY="+a, "HTTP_PROXY="+a, "ALL_PROXY="+a)
	}
	return out
}

// Redact is a proxy address with any password in it replaced, for a log
// line or an error.
func Redact(proxy string) string {
	u, err := Parse(proxy)
	if err != nil || u.User == nil {
		return proxy
	}
	if _, has := u.User.Password(); has {
		u.User = url.UserPassword(u.User.Username(), "redacted")
	}
	return u.String()
}
