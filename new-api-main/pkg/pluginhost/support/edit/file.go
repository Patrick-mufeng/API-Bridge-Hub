// Package edit writes a file atomically: the whole contents to a temporary
// file beside it, flushed to the disk, then renamed over.
//
// The rename is what makes it atomic; the flush is what makes it survive a
// machine that goes down. A Windows machine that went down mid-write left a
// state file at its full length with every byte zero, which the next read
// took for an empty account list and the next write made final (#1505). Only
// the part of magpie's internal/edit the plugin host needs is here.
package edit

import (
	"os"
	"path/filepath"

	"github.com/QuantumNous/new-api/pkg/pluginhost/support/lastgood"
	"github.com/QuantumNous/new-api/pkg/pluginhost/support/steady"
)

// WriteAtomic replaces the file at path with data, keeping what was there
// first: a valid copy becomes the file's last good generation (its .bak),
// one that doesn't parse is copied aside before it is written over, so a
// file that can't be read is never lost by a write that read it as empty.
// A write that fails leaves the file as it was.
func WriteAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := lastgood.KeepUnparsed(path, lastgood.JSON); err != nil {
		return err
	}
	return steady.WriteFile(path, data, 0o600)
}
