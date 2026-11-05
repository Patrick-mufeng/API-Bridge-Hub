// Package ghtoken has the plugin host's requests to GitHub's REST API carry
// a token, and says plainly when GitHub turns them away.
//
// GitHub answers an address 60 requests an hour without a token, which the
// plugins page's browsing and a few repositories' checks use up; with one it
// answers 5,000. The token is the one set in the host's settings, else
// GITHUB_TOKEN or GH_TOKEN. It goes to GitHub's API host alone and is never
// written to a log or an error.
package ghtoken

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/pkg/pluginhost/support/settings"
)

// Env names the variables a token is taken from when settings has none, in
// the order they are looked at.
var Env = []string{"GITHUB_TOKEN", "GH_TOKEN"}

// Token is the token requests to GitHub's API carry, and where it came from:
// "settings", the variable's name, or "" for none. A token GitHub refused
// isn't one, wherever it came from.
func Token() (token, from string) {
	if t := strings.TrimSpace(settings.Load().GitHubToken); t != "" {
		if isRefused(t) {
			return "", ""
		}
		return t, "settings"
	}
	for _, k := range Env {
		if t := strings.TrimSpace(env(k)); t != "" && !isRefused(t) {
			return t, k
		}
	}
	return "", ""
}

var varEnv = os.Getenv

func env(k string) string { return varEnv(k) }

// SetEnv reads variables from f instead of the process environment, for a
// test.
func SetEnv(f func(string) string) { varEnv = f }

var refused = struct {
	sync.Mutex
	m map[string]bool
}{m: map[string]bool{}}

func isRefused(t string) bool {
	refused.Lock()
	defer refused.Unlock()
	return refused.m[t]
}

func markRefused(t string) {
	refused.Lock()
	refused.m[t] = true
	refused.Unlock()
}

// Limited is GitHub's rate limit having been refused: until when (zero when
// GitHub didn't say), and whether the request carried a token.
type Limited struct {
	Until time.Time
	Token bool
}

func (e Limited) Error() string {
	when := "for a while"
	if !e.Until.IsZero() {
		when = "until " + e.Until.Local().Format("15:04")
	}
	if e.Token {
		return "GitHub's rate limit for your GitHub token is used up " + when + "; try again then"
	}
	return "GitHub's rate limit for requests without a token (60 an hour) is used up " + when +
		". Add a GitHub token in the plugin host's settings to raise it to 5,000 an hour"
}

// Refused is GitHub refusing a request for want of access, for an answer
// that says 401 or 403 without being a limit.
func Refused() error { return errRefused }

var errRefused = &refusedError{}

type refusedError struct{}

func (e *refusedError) Error() string {
	return "GitHub refused the request: the token doesn't have access to it, or none was sent"
}

// LimitedBy is the Limited a refusal of GitHub's says, or false when it
// isn't one: 429, or 403 with the limit spent or a secondary limit's
// Retry-After or message.
func LimitedBy(resp *http.Response, body []byte, token bool) (Limited, bool) {
	msg := strings.ToLower(string(body))
	if resp.StatusCode != 429 && (resp.StatusCode != 403 || resp.Header.Get("X-RateLimit-Remaining") != "0" &&
		resp.Header.Get("Retry-After") == "" && !strings.Contains(msg, "rate limit")) {
		return Limited{}, false
	}
	e := Limited{Token: token}
	if n, err := strconv.ParseInt(resp.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil && n > 0 {
		e.Until = time.Unix(n, 0)
	} else if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && s > 0 {
		e.Until = time.Now().Add(time.Duration(s) * time.Second)
	}
	return e, true
}

// Do sends req with send, carrying the token when api is GitHub's API host.
// A 401 answer to a request that carried one drops that token for the rest of
// the run and asks again without it, so a check goes on with the 60 an hour
// rather than failing whole. It says whether the answer given back is to a
// request that carried the token.
func Do(req *http.Request, api string, send func(*http.Request) (*http.Response, error)) (*http.Response, bool, error) {
	t, _ := Token()
	if t == "" || !githubAPI(api) {
		resp, err := send(req)
		return resp, false, err
	}
	req.Header.Set("Authorization", "Bearer "+t)
	resp, err := send(req)
	// a mirror answers a request sent it without the token
	if err == nil && resp.Request != nil && resp.Request.Header.Get("Authorization") == "" {
		return resp, false, nil
	}
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		return resp, true, err
	}
	markRefused(t)
	again := req.Clone(req.Context())
	if req.Body != nil && req.Body != http.NoBody {
		if req.GetBody == nil {
			return resp, false, nil
		}
		b, err := req.GetBody()
		if err != nil {
			return resp, false, nil
		}
		again.Body = b
	}
	again.Header.Del("Authorization")
	resp2, err2 := send(again)
	if err2 != nil {
		return resp2, false, err2
	}
	return resp2, false, nil
}

// githubAPI is whether the address is GitHub's API's, the only one a token
// goes to.
func githubAPI(api string) bool {
	u := strings.ToLower(api)
	return strings.HasPrefix(u, "https://api.github.com/") || u == "https://api.github.com"
}

// ReadBody reads a response's body, for a caller that needs it twice.
func ReadBody(resp *http.Response, limit int64) ([]byte, error) {
	if resp.Body == nil {
		return nil, nil
	}
	defer resp.Body.Close()
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

// Describe is a rate limit's words, for a log line.
func (e Limited) Describe() string { return fmt.Sprint(e) }
