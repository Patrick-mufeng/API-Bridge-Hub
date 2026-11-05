// Package update compares versions the way npm's semver does, and restarts
// the host's own process where a plugin's install asks for it.
//
// Only the part of magpie's internal/update the plugin host calls is here:
// Newer, for a plugin's newest version against the installed one, and
// Reexec, for the restart an update of Bun or of a plugin's code needs.
package update

import (
	"cmp"
	"regexp"
	"strconv"
	"strings"
)

// semver is what parse accepts: a version with optional pre-release and
// build metadata, a leading v allowed.
var semver = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?(?:\+[0-9A-Za-z.\-]+)?$`)

// loose is a version npm also takes: one or two numbers ("1", "1.2").
var loose = regexp.MustCompile(`^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.\-]+))?(?:\+[0-9A-Za-z.\-]+)?$`)

type version struct {
	n   [3]uint64
	pre string
	ok  bool
}

func parse(v string) *version {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	if m := semver.FindStringSubmatch(v); m != nil {
		return &version{n: [3]uint64{atoi(m[1]), atoi(m[2]), atoi(m[3])}, pre: m[4], ok: true}
	}
	if m := loose.FindStringSubmatch(v); m != nil {
		return &version{n: [3]uint64{atoi(m[1]), atoi(m[2]), atoi(m[3])}, pre: m[4], ok: true}
	}
	return nil
}

func atoi(s string) uint64 {
	n, _ := strconv.ParseUint(s, 10, 64)
	return n
}

// Newer reports whether version a comes after b. A pre-release comes before
// the release it leads up to. A version that doesn't parse is never newer.
func Newer(a, b string) bool {
	x, y := parse(a), parse(b)
	if x == nil || y == nil {
		return false
	}
	for i := range 3 {
		if x.n[i] != y.n[i] {
			return x.n[i] > y.n[i]
		}
	}
	return comparePre(x.pre, y.pre) > 0
}

// comparePre orders two pre-releases the way semver does (§11): no
// pre-release comes after any; otherwise identifier by identifier, numbers as
// numbers, a number before a word, and a shorter list before a longer one it
// starts.
func comparePre(a, b string) int {
	switch {
	case a == b:
		return 0
	case a == "":
		return 1
	case b == "":
		return -1
	}
	x, y := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(x) && i < len(y); i++ {
		m, errM := strconv.ParseUint(x[i], 10, 64)
		n, errN := strconv.ParseUint(y[i], 10, 64)
		switch {
		case errM == nil && errN == nil:
			if m != n {
				return cmp.Compare(m, n)
			}
		case errM == nil:
			return -1
		case errN == nil:
			return 1
		default:
			if c := strings.Compare(x[i], y[i]); c != 0 {
				return c
			}
		}
	}
	return cmp.Compare(len(x), len(y))
}

// Released reports whether v is a release version rather than a build from
// source ("dev", a bare hash).
func Released(v string) bool { return parse(v) != nil }
