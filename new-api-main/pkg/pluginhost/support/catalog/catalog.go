// Package catalog keeps models.dev's answer about models: what context a
// model has, how many tokens it gives out, whether it reasons, and what it
// costs.
//
// A plugin's provider has the models models.dev lists for it, as in
// OpenCode: the plugin's own list says the ids, and this says the rest. The
// file is fetched into the cache folder, so a hub that can't reach
// models.dev keeps the answer it had.
//
// In magpie this package also reads every provider's shipped model list;
// only the plugin host's share is here.
package catalog

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/QuantumNous/new-api/pkg/pluginhost/support/appdir"
	"github.com/QuantumNous/new-api/pkg/pluginhost/support/filememo"
)

// URL is where models.dev's list is.
const URL = "https://models.dev/api.json"

// envSource points at a file holding the list, for a hub that serves it
// itself; the environment variable keeps a CI run off the network.
const envSource = "PLUGIN_HOST_MODELS_DEV"

// CachePath is the file the list is kept in.
func CachePath() string { return filepath.Join(appdir.Cache(), "models.json") }

// Source is the list to read instead of the cache, "" for the cache.
func Source() string {
	if v := os.Getenv(envSource); v != "" {
		if st, err := os.Stat(v); err == nil && st.Mode().IsRegular() {
			return v
		}
	}
	return ""
}

// Model is what models.dev says of one model.
type Model struct {
	ID         string      `json:"id"`
	Limit      Limit       `json:"limit"`
	Cost       *Cost       `json:"cost,omitempty"`
	Reasoning  bool        `json:"reasoning,omitempty"`
	ToolCall   bool        `json:"tool_call,omitempty"`
	Modalities *Modalities `json:"modalities,omitempty"`
	// Released is when the vendor released it, "2026-01-31", for the
	// newest-first order a picker uses.
	Released string `json:"release_date,omitempty"`
	Name     string `json:"name,omitempty"`
}

// Limit is how full a model's context may be and how much it gives out.
type Limit struct {
	Context int `json:"context,omitempty"`
	Input   int `json:"input,omitempty"`
	Output  int `json:"output,omitempty"`
}

// Cost is the model's price in USD per million tokens.
type Cost struct {
	Input  float64 `json:"input,omitempty"`
	Output float64 `json:"output,omitempty"`
	Cache  struct {
		Read  float64 `json:"read,omitempty"`
		Write float64 `json:"write,omitempty"`
	} `json:"cache,omitempty"`
}

// Modalities is what a model takes and gives.
type Modalities struct {
	Input  []string `json:"input,omitempty"`
	Output []string `json:"output,omitempty"`
}

// Provider is one vendor's entry: its models by id.
type Provider struct {
	ID     string           `json:"id"`
	Name   string           `json:"name,omitempty"`
	Models map[string]Model `json:"models"`
}

var (
	mu     sync.Mutex
	loaded atomic.Pointer[map[string]Provider]
)

// All is the whole list, by provider id. A list that can't be read is
// empty, not fatal: what a plugin's own list says still serves.
func All() map[string]Provider {
	if m := loaded.Load(); m != nil {
		return *m
	}
	mu.Lock()
	defer mu.Unlock()
	if m := loaded.Load(); m != nil {
		return *m
	}
	m := map[string]Provider{}
	p := Source()
	if p == "" {
		p = CachePath()
	}
	b, err := filememo.Read("models.dev", p, func(b []byte) ([]byte, error) { return b, nil })
	if err == nil && len(b) > 0 {
		_ = json.Unmarshal(b, &m)
	}
	loaded.Store(&m)
	return m
}

// Reset has the next All read the file again.
func Reset() {
	loaded.Store(nil)
	filememo.Forget()
}

// SyncIfMissing fetches the list when there is none, and keeps what it got.
// It is called in the background, so starting a plugin host never waits on
// models.dev.
func SyncIfMissing(ctx context.Context) error {
	if p := Source(); p != "" {
		return nil
	}
	if b, err := os.ReadFile(CachePath()); err == nil && len(b) > 0 && json.Valid(b) {
		return nil
	}
	return Sync(ctx)
}

// Sync fetches the list and keeps it.
func Sync(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, URL, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return &httpError{Status: resp.StatusCode}
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return err
	}
	if !json.Valid(b) {
		return &formatError{}
	}
	if err := os.MkdirAll(filepath.Dir(CachePath()), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(CachePath(), b, 0o600); err != nil {
		return err
	}
	Reset()
	return nil
}

type httpError struct{ Status int }

func (e *httpError) Error() string { return "models.dev answered " + http.StatusText(e.Status) }

type formatError struct{}

func (e *formatError) Error() string { return "models.dev's answer isn't JSON" }

// LastRead is when the file was last written, zero when there is none.
func LastRead() time.Time {
	st, err := os.Stat(CachePath())
	if err != nil {
		return time.Time{}
	}
	return st.ModTime()
}
