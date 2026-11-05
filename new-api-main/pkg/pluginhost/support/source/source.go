// Package source chooses where the plugin host reads from: the official
// address first, a mirror after it when the official one can't be reached.
//
// The 「国内镜像」 switch puts a mirror in China first for the addresses one
// serves byte for byte (npmmirror for npm's registry and Bun's releases,
// jsDelivr for the community plugin list). A proxy such as gh-proxy is never
// used for those: it would hand the host whatever it liked.
package source

import (
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"

	"github.com/QuantumNous/new-api/pkg/pluginhost/support/settings"
)

const (
	npmMirror    = "https://registry.npmmirror.com"
	githubMirror = "https://gh-proxy.com"
	bunMirror    = "https://registry.npmmirror.com/-/binary/bun"
	listMirror   = "https://cdn.jsdelivr.net/gh/magpie-community/plugins@"
)

// NPMMirror is npm's registry in China.
const NPMMirror = npmMirror

var (
	chinaMu   sync.Mutex
	chinaFunc = func() bool { return settings.Load().ChinaMirror }
)

// China is whether the 「国内镜像」 switch is on.
func China() bool {
	chinaMu.Lock()
	f := chinaFunc
	chinaMu.Unlock()
	return f()
}

// SetChina stands in for the switch, for a test.
func SetChina(f func() bool) {
	chinaMu.Lock()
	chinaFunc = f
	chinaMu.Unlock()
}

// ChinaFirst is the mirror in China asked before raw, "" with the switch
// off or when no mirror serves raw.
func ChinaFirst(raw string) string {
	if !China() {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" {
		return ""
	}
	switch strings.ToLower(u.Hostname()) {
	case "registry.npmjs.org":
		return npmMirror + u.RequestURI()
	case "github.com":
		if rest, ok := strings.CutPrefix(u.EscapedPath(), "/oven-sh/bun/releases/download/"); ok && rest != "" {
			return bunMirror + "/" + rest
		}
	case "raw.githubusercontent.com":
		// /magpie-community/plugins/<branch>/<path>
		if rest, ok := strings.CutPrefix(u.EscapedPath(), "/magpie-community/plugins/"); ok {
			if ref, p, ok := strings.Cut(rest, "/"); ok && ref != "" && p != "" && u.RawQuery == "" {
				return listMirror + ref + "/" + p
			}
		}
	}
	return ""
}

// URLs is the official address followed by its mirrors: the one in China
// first with the switch on, a fallback mirror after it with
// MAGPIE_MIRRORS=on.
func URLs(raw string) []string {
	out := []string{}
	if m := ChinaFirst(raw); m != "" {
		out = append(out, m)
	}
	out = append(out, raw)
	if m := mirrorOf(raw); m != "" {
		out = append(out, m)
	}
	return distinct(out...)
}

// mirrorOf is the fallback mirror for raw, "" when it has none or the
// mirrors switch is off.
func mirrorOf(raw string) string {
	if !Enabled() {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	switch strings.ToLower(u.Hostname()) {
	case "registry.npmjs.org":
		return npmBase() + u.RequestURI()
	case "github.com", "api.github.com", "raw.githubusercontent.com", "codeload.github.com":
		return githubBase() + "/" + raw
	}
	return ""
}

// Enabled reports whether mirror fallback was turned on with
// MAGPIE_MIRRORS=on (or true, 1, cn).
func Enabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("MAGPIE_MIRRORS"))) {
	case "on", "true", "1", "cn":
		return true
	}
	return false
}

func npmBase() string {
	if v := strings.TrimRight(strings.TrimSpace(os.Getenv("MAGPIE_NPM_REGISTRY")), "/"); v != "" {
		return v
	}
	return npmMirror
}

func githubBase() string {
	if v := strings.TrimRight(strings.TrimSpace(os.Getenv("MAGPIE_GITHUB_MIRROR")), "/"); v != "" {
		return v
	}
	return githubMirror
}

func distinct(xs ...string) []string {
	seen := map[string]bool{}
	out := xs[:0]
	for _, x := range xs {
		if x == "" || seen[x] {
			continue
		}
		seen[x] = true
		out = append(out, x)
	}
	return out
}

// Do sends req to its address, asking the addresses URLs gives it in their
// order until one answers. A redirect to another address is followed by the
// client as usual.
func Do(c *http.Client, req *http.Request) (*http.Response, error) {
	return do(c, req, URLs(req.URL.String()), true)
}

// DoOfficial sends req to its own address alone.
func DoOfficial(c *http.Client, req *http.Request) (*http.Response, error) {
	return c.Do(req)
}

// DoFaithful sends req to its own address and then to a mirror that serves
// the same bytes, as Do does, but only the one the 「国内镜像」 switch asks
// for, never a proxy.
func DoFaithful(c *http.Client, req *http.Request) (*http.Response, error) {
	urls := []string{}
	if m := ChinaFirst(req.URL.String()); m != "" {
		urls = append(urls, m)
	}
	urls = append(urls, req.URL.String())
	return do(c, req, urls, true)
}

// do asks the addresses in order. Without auth, the Authorization header is
// dropped for a mirror: it is the user's token, and a mirror isn't GitHub.
func do(c *http.Client, req *http.Request, urls []string, auth bool) (*http.Response, error) {
	var firstErr error
	for i, u := range urls {
		r := req
		if i > 0 {
			r = req.Clone(req.Context())
			if parsed, err := url.Parse(u); err == nil {
				r.URL = parsed
			}
			if !auth {
				r.Header.Del("Authorization")
			}
			if req.GetBody != nil {
				if b, err := req.GetBody(); err == nil {
					r.Body = b
				}
			}
		}
		resp, err := c.Do(r)
		if err == nil {
			return resp, nil
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return nil, firstErr
}
