package lastgood

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// A file that is there but not valid is UNKNOWN, never empty: its last good
// generation is read instead. This is what keeps a crashed write from
// erasing an account list, which is the reason this package exists.
func TestReadGivesTheLastGoodGeneration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.json")

	good := []byte(`{"workbuddy":{}}`)
	if err := os.WriteFile(path, good, 0o600); err != nil {
		t.Fatal(err)
	}
	// a write keeps the valid copy as the .bak before replacing the file:
	// Keep is what a writer calls on the file it is about to replace
	if err := Keep(path, JSON, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(Bak(path)); err != nil {
		t.Fatalf("no last good generation was kept: %v", err)
	}
	// the machine went down mid-write: same length, every byte zero
	broken := make([]byte, len(good))
	if err := os.WriteFile(path, broken, 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := Read(path, JSON)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(got) != string(good) {
		t.Fatalf("Read = %q, want the last good generation %q", got, good)
	}
}

// A file that is there, broken, and has no good backup is an error: a caller
// must not be handed an empty list to act on.
func TestReadRefusesAnUnreadableFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Read(path, JSON); err == nil {
		t.Fatal("a broken file with no backup was read as valid")
	} else if !errors.Is(err, ErrUnreadable) {
		t.Fatalf("Read error = %v, want ErrUnreadable", err)
	}
}

// A file that isn't there is ErrNotExist, not an unreadable one: a caller
// tells "never written" from "written and lost".
func TestReadMissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nothing.json")
	_, err := Read(path, JSON)
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Read error = %v, want ErrNotExist", err)
	}
}

// A file of zero bytes is not a good copy: that is exactly what a crash
// leaves behind.
func TestJSONRejectsWhatACrashLeaves(t *testing.T) {
	bad := [][]byte{
		nil,
		{},
		[]byte("   "),
		[]byte("\n\t "),
		make([]byte, 4096), // full length, every byte zero
	}
	for _, b := range bad {
		if JSON(b) {
			t.Errorf("JSON(%q) = true, want false", b)
		}
	}
	good := [][]byte{
		[]byte("{}"),
		[]byte("[]"),
		[]byte(`{"a":1}`),
		append([]byte("\xef\xbb\xbf"), []byte("{}")...), // a UTF-8 BOM
	}
	for _, b := range good {
		if !JSON(b) {
			t.Errorf("JSON(%q) = false, want true", b)
		}
	}
}

// KeepUnparsed copies a file that doesn't parse aside before it is written
// over, so the write of what was read as empty doesn't lose what it held.
func TestKeepUnparsedKeepsABrokenFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.json")
	broken := []byte("{half a writ")
	if err := os.WriteFile(path, broken, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := KeepUnparsed(path, JSON); err != nil {
		t.Fatal(err)
	}
	// a copy is kept beside it, and the file itself is untouched
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) < 2 {
		t.Fatalf("nothing was kept: %v", entries)
	}
	now, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(now) != string(broken) {
		t.Fatalf("the file was changed: %q", now)
	}
}

// Into is for a reader that takes a file of the wrong shape as empty: a bare
// [] parses as JSON but holds no map, which such a reader would see nothing
// in.
func TestInto(t *testing.T) {
	if Into[map[string]any]([]byte("[]")) {
		t.Error("a bare [] was taken as a map")
	}
	if !Into[map[string]any]([]byte(`{"a":1}`)) {
		t.Error("a map was rejected")
	}
	if Into[map[string]any](nil) {
		t.Error("nil was taken as a map")
	}
}
