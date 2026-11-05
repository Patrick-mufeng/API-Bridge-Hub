// Package settings keeps what the plugin host itself is told to do: which
// npm registry plugins come from, the options given to plugins, and the
// mirrors switch.
//
// In magpie this is the application's whole settings file. Here it is the
// plugin host's share of the hub's settings, kept in one file of its own so
// a change to the hub's option table never rewrites what a plugin is told.
package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/QuantumNous/new-api/pkg/pluginhost/support/appdir"
	"github.com/QuantumNous/new-api/pkg/pluginhost/support/edit"
	"github.com/QuantumNous/new-api/pkg/pluginhost/support/filememo"
)

// Settings is what the host keeps between runs.
type Settings struct {
	// NPMRegistry is the registry plugins are installed from, "" for the
	// user's own setup or npm's.
	NPMRegistry string `json:"npmRegistry,omitempty"`
	// ChinaMirror puts a mirror in China first for the addresses that have
	// one (npmmirror for npm and Bun, jsDelivr for the plugin list).
	ChinaMirror bool `json:"chinaMirror,omitempty"`
	// GitHubToken is the token requests to GitHub's API carry, "" for the
	// environment's (GITHUB_TOKEN, GH_TOKEN), else none.
	GitHubToken string `json:"githubToken,omitempty"`
	// PluginOptions are the values plugins are handed as their second
	// argument, by provider id: what a plugin's own options editor sets.
	PluginOptions map[string]map[string]any `json:"pluginOptions,omitempty"`
	// Enabled is whether the plugin host runs at all. Off, no Bun is
	// started and no plugin's models are served, which is what a hub that
	// has never installed one does.
	Enabled bool `json:"enabled,omitempty"`
}

// Dir is where the host's files are.
func Dir() string { return appdir.Config() }

// Path is the settings file.
func Path() string { return filepath.Join(Dir(), "settings.json") }

var (
	mu     sync.Mutex
	cached atomic.Pointer[Settings]
	parses atomic.Int64
)

// Load is the settings, from memory while the file is unchanged.
func Load() Settings {
	if s := cached.Load(); s != nil {
		return *s
	}
	mu.Lock()
	defer mu.Unlock()
	if s := cached.Load(); s != nil {
		return *s
	}
	s := Settings{}
	b, err := filememo.Read("plugin-host settings", Path(), func(b []byte) ([]byte, error) { return b, nil })
	if err == nil && len(b) > 0 {
		if json.Unmarshal(b, &s) != nil {
			// a file that doesn't parse is unknown, not blank: the
			// defaults stand and the next Save keeps a copy of it
			s = Settings{}
		}
	}
	parses.Add(1)
	cached.Store(&s)
	return s
}

// Save keeps s, under the old copy as its last good generation.
func Save(s Settings) error {
	mu.Lock()
	defer mu.Unlock()
	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := edit.WriteAtomic(Path(), append(b, '\n')); err != nil {
		return err
	}
	cached.Store(&s)
	filememo.Forget()
	return nil
}

// Reset has the next Load read the file again (a test's, and what a page
// that just wrote it asks for).
func Reset() {
	cached.Store(nil)
	filememo.Forget()
}

// SavedAddr is the address the host's gateway answers on. This build has no
// gateway of its own: the hub's relay is the only endpoint, so it is "".
func SavedAddr() string { return "" }
