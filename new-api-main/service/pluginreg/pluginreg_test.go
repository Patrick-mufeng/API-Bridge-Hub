package pluginreg

import (
	"testing"
)

// A channel tag ties a plugin account to the one channel that serves it,
// which is what re-registering and health syncing both look it up by.
func TestTagFor(t *testing.T) {
	got := TagFor("workbuddy", "workbuddy#2apscn")
	want := "plugin:workbuddy:workbuddy#2apscn"
	if got != want {
		t.Errorf("TagFor = %q, want %q", got, want)
	}
	// the first account is kept under the provider's own id
	if got := TagFor("workbuddy", "workbuddy"); got != "plugin:workbuddy:workbuddy" {
		t.Errorf("TagFor(first account) = %q", got)
	}
}

// A package's kind is read off its name, which is how the community names
// them. It decides the order the market is shown in and whether a page
// offers it as something the relay can serve.
func TestKindOf(t *testing.T) {
	cases := []struct{ spec, want string }{
		{"@magpie-community/opencode-workbuddy-auth", "provider"},
		{"@magpie-community/opencode-qoder-auth", "provider"},
		{"@magpie-community/middleware-model-map", "middleware"},
		{"@magpie-community/middleware-param-override", "middleware"},
		{"@magpie-community/agent-aider", "agent"},
		{"@magpie-community/tools-calc", "tools"},
		{"@magpie-community/page-chat", "page"},
	}
	for _, c := range cases {
		if got := kindOf(c.spec); got != c.want {
			t.Errorf("kindOf(%q) = %q, want %q", c.spec, got, c.want)
		}
	}
	// provider plugins rank first: they are what the relay can serve, and
	// the rest follow in the order the market shows them
	order := []string{"", "middleware", "agent", "tools", "page"}
	for i := 1; i < len(order); i++ {
		if kindRank(order[i-1]) > kindRank(order[i]) {
			t.Errorf("%q ranks after %q", order[i-1], order[i])
		}
	}
}

// A channel that a health sync turned off is turned back on once the
// account works again; one an operator turned off by hand is left alone.
// This is the difference between the two disabled states, and getting it
// wrong would re-enable a channel someone meant to keep off.
func TestHealthOnlyMovesItsOwnChannels(t *testing.T) {
	// the statuses, as the relay defines them
	const (
		enabled = 1
		manual  = 2
		autoOff = 3
	)
	moves := func(healthy bool, status int) (want bool, wantStatus int) {
		switch {
		case !healthy && status == enabled:
			return true, autoOff
		case healthy && status == autoOff:
			return true, enabled
		}
		return false, status
	}
	cases := []struct {
		name    string
		healthy bool
		status  int
		move    bool
		after   int
	}{
		{"lapsed and on", false, enabled, true, autoOff},
		{"lapsed, already off by us", false, autoOff, false, autoOff},
		{"lapsed, turned off by hand", false, manual, false, manual},
		{"fine and off by us", true, autoOff, true, enabled},
		{"fine and on", true, enabled, false, enabled},
		{"fine, turned off by hand", true, manual, false, manual},
	}
	for _, c := range cases {
		move, after := moves(c.healthy, c.status)
		if move != c.move || after != c.after {
			t.Errorf("%s: move=%v after=%d, want move=%v after=%d", c.name, move, after, c.move, c.after)
		}
	}
}
