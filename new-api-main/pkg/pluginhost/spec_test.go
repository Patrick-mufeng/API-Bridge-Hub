package pluginhost

import (
	"strings"
	"testing"
)

// A spec is written the way a person copies it from npm: a name, a name and
// a version, or a path or repository. Name takes the version off and leaves
// the scope, which Target then turns into the folder under node_modules.
func TestNameAndTarget(t *testing.T) {
	cases := []struct{ spec, name string }{
		{"@magpie-community/opencode-workbuddy-auth", "@magpie-community/opencode-workbuddy-auth"},
		{"@magpie-community/opencode-workbuddy-auth@0.2.20", "@magpie-community/opencode-workbuddy-auth"},
		{"@magpie-community/opencode-workbuddy-auth@latest", "@magpie-community/opencode-workbuddy-auth"},
		{"opencode-plain-auth", "opencode-plain-auth"},
		{"opencode-plain-auth@1.2.3", "opencode-plain-auth"},
	}
	for _, c := range cases {
		if got := Name(c.spec); got != c.name {
			t.Errorf("Name(%q) = %q, want %q", c.spec, got, c.name)
		}
	}
	// a scoped package's folder keeps its scope, and loses the version
	got := Target("@magpie-community/opencode-workbuddy-auth@0.2.20")
	if !strings.Contains(got, "node_modules") || !strings.Contains(got, "opencode-workbuddy-auth") {
		t.Errorf("Target = %q, want it under node_modules", got)
	}
	if strings.Contains(got, "@0.2.20") {
		t.Errorf("Target = %q, the version should not be in the folder", got)
	}
}

// A path and a repository are told apart from an npm name: they are loaded
// where they are, not fetched.
func TestIsPathAndIsGit(t *testing.T) {
	paths := []string{"./plugin", "/tmp/plugin", "C:/plugin", "file:///tmp/plugin"}
	for _, p := range paths {
		if !IsPath(p) {
			t.Errorf("IsPath(%q) = false, want true", p)
		}
	}
	repos := []string{"github:owner/repo", "git+https://example.com/x.git"}
	for _, r := range repos {
		if !IsGit(r) {
			t.Errorf("IsGit(%q) = false, want true", r)
		}
	}
	if IsPath("@magpie-community/opencode-workbuddy-auth") {
		t.Error("an npm name was taken for a path")
	}
	if IsGit("@magpie-community/opencode-workbuddy-auth") {
		t.Error("an npm name was taken for a repository")
	}
}

// A sign-in is filed under the provider's own id, others under id#slot.
// Everything that finds an account's channel goes through ProviderOf, so
// getting it wrong would make accounts unreachable.
func TestProviderOf(t *testing.T) {
	cases := []struct{ key, provider string }{
		{"workbuddy", "workbuddy"},
		{"workbuddy#2apscn", "workbuddy"},
		{"workbuddy#xbpn48", "workbuddy"},
		{"workbuddy-ai", "workbuddy-ai"},
		{"workbuddy-ai#x", "workbuddy-ai"},
	}
	for _, c := range cases {
		if got := ProviderOf(c.key); got != c.provider {
			t.Errorf("ProviderOf(%q) = %q, want %q", c.key, got, c.provider)
		}
	}
}

// accountsOf lists a provider's sign-ins with the one under its own id
// first: that is the account a request naming none goes as.
func TestAccountsOfPutsTheFirstFirst(t *testing.T) {
	auth := map[string]storedAuth{
		"workbuddy":    {Type: "oauth"},
		"workbuddy#z":  {Type: "oauth"},
		"workbuddy#a":  {Type: "oauth"},
		"workbuddy-ai": {Type: "oauth"},
		"other#x":      {Type: "oauth"},
	}
	got := accountsOf(auth, "workbuddy")
	if len(got) != 3 {
		t.Fatalf("accountsOf = %v, want 3 entries", got)
	}
	if got[0].Key != "workbuddy" {
		t.Errorf("the provider's own id is not first: %v", keysOf(got))
	}
	if got[1].Key != "workbuddy#a" || got[2].Key != "workbuddy#z" {
		t.Errorf("the rest are not in order: %v", keysOf(got))
	}
	// another provider's accounts are not listed, and a name that only
	// looks alike is not one of them
	for _, a := range got {
		if a.Key == "workbuddy-ai" || a.Key == "other#x" {
			t.Errorf("accountsOf listed %q, which is another provider's", a.Key)
		}
	}
}

// An API key's hint is its last four characters, so two accounts with no
// name are told apart in a list. A key too short to be one gets none.
func TestAccountHintForApiKeys(t *testing.T) {
	auth := map[string]storedAuth{
		"p": {Type: "api", Key: "sk-0123456789abcdef"},
	}
	got := accountsOf(auth, "p")
	if len(got) != 1 {
		t.Fatal("the account is missing")
	}
	if got[0].Hint != "cdef" {
		t.Errorf("Hint = %q, want the last four", got[0].Hint)
	}
	// an oauth sign-in has no key to hint with
	auth["p"] = storedAuth{Type: "oauth", Key: "short"}
	if got := accountsOf(auth, "p"); got[0].Hint != "" {
		t.Errorf("an oauth account got a hint: %q", got[0].Hint)
	}
}

// A registry address is either an http(s) URL with a host or the word
// "default"; anything else is refused rather than kept, so a typo cannot
// point every install somewhere unexpected.
func TestCleanRegistry(t *testing.T) {
	good := []string{
		"https://registry.npmmirror.com",
		"https://registry.npmjs.org/",
		"http://localhost:4873",
	}
	for _, u := range good {
		if _, err := CleanRegistry(u); err != nil {
			t.Errorf("CleanRegistry(%q) = %v, want no error", u, err)
		}
	}
	got, err := CleanRegistry("https://registry.npmjs.org/")
	if err != nil || got != "https://registry.npmjs.org" {
		t.Errorf("CleanRegistry trimmed = %q (%v)", got, err)
	}
	bad := []string{"registry.npmjs.org", "ftp://example.com", "https://", "https://example.com/?a=1"}
	for _, u := range bad {
		if _, err := CleanRegistry(u); err == nil {
			t.Errorf("CleanRegistry(%q) accepted it", u)
		}
	}
	if got, err := CleanRegistry("  "); err != nil || got != "" {
		t.Errorf("CleanRegistry(empty) = %q (%v)", got, err)
	}
}

func keysOf(as []Account) []string {
	out := make([]string, len(as))
	for i, a := range as {
		out[i] = a.Key
	}
	return out
}
