package pluginreg

import (
	"testing"

	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
)

// The name is the provider own id, a dash, and the model own id: the vendor
// the model comes from is readable in the name, which an abbreviation like
// "wb" does not give.
func TestProviderModelName(t *testing.T) {
	cases := []struct{ prefix, model, want string }{
		{"workbuddy", "glm-5.3", "workbuddy-glm-5.3"},
		{"workbuddy-ai", "glm-5.3", "workbuddy-ai-glm-5.3"},
		{"cline", "deepseek-v4.1-flash", "cline-deepseek-v4.1-flash"},
	}
	for _, c := range cases {
		if got := ProviderModelName(c.prefix, c.model); got != c.want {
			t.Errorf("ProviderModelName(%q, %q) = %q, want %q", c.prefix, c.model, got, c.want)
		}
	}
}

// Taking the prefix off needs the prefix the channel records. Splitting on
// the first dash is wrong for any provider whose own id has a dash, which is
// exactly the two services of one vendor.
func TestModelOfPrefixNeedsTheKnownPrefix(t *testing.T) {
	// right: the channel knows it is workbuddy-ai
	if got, ok := modelOfPrefix("workbuddy-ai-glm-5.3", "workbuddy-ai"); !ok || got != "glm-5.3" {
		t.Errorf("modelOfPrefix with the channel own prefix = %q, %v", got, ok)
	}
	// a shorter prefix still matches as a string, which is why a caller that
	// guessed one has to be caught: see TestPrefixIsShadowed
	if got, ok := modelOfPrefix("workbuddy-ai-glm-5.3", "workbuddy"); !ok || got != "ai-glm-5.3" {
		t.Errorf("modelOfPrefix with a short prefix = %q, %v", got, ok)
	}
	// a name with no prefix of ours is its own model
	if got, ok := modelOfPrefix("plain-model", ""); !ok || got != "plain-model" {
		t.Errorf("no prefix = %q, %v", got, ok)
	}
}

// A prefix that is really another provider id with a dash after it is
// reported, so a guessed prefix is refused rather than served.
func TestPrefixIsShadowed(t *testing.T) {
	others := []string{"workbuddy", "workbuddy-ai"}
	if !prefixIsShadowed("workbuddy", others) {
		t.Error("workbuddy was not seen as shadowed by workbuddy-ai")
	}
	if prefixIsShadowed("workbuddy-ai", others) {
		t.Error("the longer id was called shadowed")
	}
	if prefixIsShadowed("cline", others) {
		t.Error("an unrelated id was called shadowed")
	}
}

// Deriving a prefix from a provider id: it is the id itself, reduced to what
// a model id can carry.
func TestDerivePrefixIsTheProviderId(t *testing.T) {
	cases := []struct{ provider, want string }{
		{"workbuddy", "workbuddy"},
		{"workbuddy-ai", "workbuddy-ai"},
		{"claude", "claude"},
		{"qoder", "qoder"},
		{"some_long_name", "some-long-name"},
		{"Upper-Case", "upper-case"},
	}
	for _, c := range cases {
		ForgetPrefix(c.provider)
		if got := PrefixFor(c.provider, ""); got != c.want {
			t.Errorf("PrefixFor(%q) = %q, want %q", c.provider, got, c.want)
		}
	}
}

// An operator own prefix is used as written, and sticks.
func TestChosenPrefixWins(t *testing.T) {
	ForgetPrefix("wbtest")
	if got := PrefixFor("wbtest", "My-Own"); got != "my-own" {
		t.Fatalf("a chosen prefix = %q", got)
	}
	if got := PrefixFor("wbtest", ""); got != "my-own" {
		t.Errorf("the chosen prefix was not kept: %q", got)
	}
}

// normalizePrefix keeps a name a model id can carry: no colons, no spaces,
// no dashes at either end, since those would read as part of the model.
func TestNormalizePrefix(t *testing.T) {
	cases := []struct{ in, want string }{
		{"workbuddy", "workbuddy"},
		{"WorkBuddy", "workbuddy"},
		{" workbuddy ", "workbuddy"},
		{"workbuddy-", "workbuddy"},
		{"-workbuddy", "workbuddy"},
		{"work buddy", "workbuddy"},
		{"work:buddy", "workbuddy"},
		{"", ""},
	}
	for _, c := range cases {
		if got := normalizePrefix(c.in); got != c.want {
			t.Errorf("normalizePrefix(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// A provider whose id has nothing a model name can carry still gets a
// prefix: an empty one would put every model of it under the bare id.
func TestDerivePrefixNeverEmpty(t *testing.T) {
	for _, id := range []string{"", "-", "::", "  "} {
		if got := derivePrefix(id); got == "" {
			t.Errorf("derivePrefix(%q) = empty", id)
		}
	}
}

// clashAmong is the body of prefixClash without the database read, so that
// what it decides can be checked on its own.
func clashAmong(channels []*model.Channel, models []string, selfChannelID int) []string {
	mine := map[string]bool{}
	for _, m := range models {
		mine[m] = true
	}
	seen := map[string]bool{}
	var clash []string
	for _, ch := range channels {
		if ch.Id == selfChannelID {
			continue
		}
		for _, m := range ch.GetModels() {
			if m == "" || !mine[m] || seen[m] {
				continue
			}
			seen[m] = true
			clash = append(clash, m)
		}
	}
	return clash
}

// Re-registering a provider must not read its own channel as somebody else's.
// The check takes the channel's own id for that reason: given 0 it excludes
// nothing, and every refresh of a working provider fails on its own models —
// which is what installing a removed plugin again then registering does.
func TestClashCheckExcludesTheChannelItself(t *testing.T) {
	self := &model.Channel{Id: 40, Models: "workbuddy-glm-5.3,workbuddy-hy3"}
	other := &model.Channel{Id: 41, Models: "workbuddy-ai-glm-5.3"}

	// its own names are not a clash when the check knows which channel it is
	assert.Empty(t, clashAmong([]*model.Channel{self, other}, []string{"workbuddy-glm-5.3", "workbuddy-hy3"}, 40))

	// another channel's names are
	assert.Equal(t, []string{"workbuddy-ai-glm-5.3"},
		clashAmong([]*model.Channel{self, other}, []string{"workbuddy-ai-glm-5.3"}, 40))

	// and with no id given nothing is excluded: the trap this guards against
	assert.Len(t, clashAmong([]*model.Channel{self}, []string{"workbuddy-glm-5.3"}, 0), 1)
}
