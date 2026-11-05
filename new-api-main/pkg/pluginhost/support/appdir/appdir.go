// Package appdir decides where the plugin host keeps its own files.
//
// In magpie this package answers for the whole application; here it answers
// for one subsystem. The layout is the hub's: a data folder beside the
// server binary, the same place the rest of the hub keeps its
// manifests, so a backup of the data folder is a backup of everything the
// host owns.
package appdir

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	// envConfig overrides where the host keeps what it must not lose:
	// plugins.json, plugin-auth.json, plugin-providers.json.
	envConfig = "PLUGIN_HOST_CONFIG_DIR"
	// envCache overrides where it keeps what it can fetch again: Bun, the
	// model catalog, the plugin market's last answer.
	envCache = "PLUGIN_HOST_CACHE_DIR"
	// dataName is the folder beside the server binary that holds the hub's
	// state, as the plugin host's own files are kept under it.
	dataName = "data"
	// sub is this subsystem's folder under the hub's data folder.
	sub = "plugin-host"
)

var (
	once   sync.Once
	config string
	cache  string
)

func dirs() {
	if v := strings.TrimSpace(os.Getenv(envConfig)); v != "" {
		config = v
	} else {
		config = filepath.Join(root(), dataName, sub)
	}
	if v := strings.TrimSpace(os.Getenv(envCache)); v != "" {
		cache = v
	} else {
		cache = filepath.Join(root(), dataName, sub, "cache")
	}
}

// root is the folder the hub runs from: where its binary is, else the
// working folder. A relative data folder is what the hub's own start
// scripts set up, so it sits beside the server in development too.
func root() string {
	exe, err := os.Executable()
	if err != nil {
		if wd, err := os.Getwd(); err == nil {
			return wd
		}
		return "."
	}
	return filepath.Dir(exe)
}

// Config is where the host keeps the files it must not lose.
func Config() string {
	once.Do(dirs)
	return config
}

// Cache is where it keeps what it can fetch again.
func Cache() string {
	once.Do(dirs)
	return cache
}

// Join is filepath.Join under dir, making dir first.
func Join(dir string, parts ...string) string {
	return filepath.Join(append([]string{dir}, parts...)...)
}

// Getenv is os.Getenv, for a name the host reads from the environment.
func Getenv(k string) string { return os.Getenv(k) }
