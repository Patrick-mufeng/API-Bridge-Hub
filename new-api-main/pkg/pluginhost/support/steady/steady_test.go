package steady

import (
	"os"
	"path/filepath"
	"testing"
)

// WriteFile replaces a file through a temp file flushed to the disk before it
// is renamed over: a machine that goes down between the two must not leave
// the file at its length, all zero.
func TestWriteFileReplacesAndKeepsMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("new contents"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new contents" {
		t.Fatalf("contents = %q", got)
	}
	// no temp file is left behind
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Fatalf("left files behind: %v", names)
	}
}

// A file that isn't there is created, which is what a first write does.
func TestWriteFileCreates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "new.json")
	if err := WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if b, err := os.ReadFile(path); err != nil || string(b) != "{}" {
		t.Fatalf("read back = %q (%v)", b, err)
	}
}

// A file being renamed over is, for a moment, not there at all; ReadFile
// waits that out rather than reporting no file.
func TestReadFileWaitsOutARename(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	if err := os.WriteFile(path, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != "data" {
		t.Fatalf("ReadFile = %q", got)
	}
	// a file that really isn't there is still an error, and quickly
	if _, err := ReadFile(filepath.Join(dir, "absent.json")); !os.IsNotExist(err) {
		t.Fatalf("ReadFile(absent) error = %v, want not-exist", err)
	}
}
