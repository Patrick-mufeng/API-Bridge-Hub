package pluginreg

import (
	"fmt"
	"strings"
	"sync"

	"github.com/QuantumNous/new-api/model"
)

// A provider models are namespaced in the relay, because two providers
// serving one model id would otherwise collide: new-api ability table is
// keyed by (group, model, channel), so both channels would answer for
// "glm-5.3" and a request would go to whichever came up.
//
// The name is the provider own id and the model, joined by a dash:
//
//	workbuddy     + glm-5.3  →  workbuddy-glm-5.3
//	workbuddy-ai  + glm-5.3  →  workbuddy-ai-glm-5.3
//
// A dash is used because it is what a model id already looks like, so the
// relay name reads as one name rather than as two fields. That is also why
// the prefix can never be recovered by splitting on the first dash:
// "workbuddy-ai-glm-5.3" cut at its first dash is "ai-glm-5.3". Every
// place that has to take a prefix off reads it from the channel, which
// records what it was given (ChannelOtherSettings.PluginPrefix).

// sep is what joins a provider id to a model id.
const sep = "-"

// knownPrefixes are the namespaces this hub already serves its providers
// under, kept as they were set by hand before the rule was the full id.
// They are migrated to the id form by MigratePrefixes.
var knownPrefixes = map[string]string{
	"workbuddy": "workbuddy",
	"cline":     "cline",
	"cmdgo":     "cmdgo",
	"qoder":     "qoder",
	"trae":      "trae",
}

// prefixesTaken is the namespace each provider registered in this process
// was given, so a second one of a family does not reuse it.
var prefixesTaken sync.Map // provider id → prefix

// PrefixFor is the namespace a provider models are exposed under, without
// the separator: "workbuddy" for workbuddy.
//
// A prefix an operator chose is used as written; one already worked out is
// kept, so a rule change never renames models under a running hub.
func PrefixFor(provider, chosen string) string {
	if p := normalizePrefix(chosen); p != "" {
		prefixesTaken.Store(provider, p)
		return p
	}
	if v, ok := prefixesTaken.Load(provider); ok {
		return v.(string)
	}
	p := derivePrefix(provider)
	prefixesTaken.Store(provider, p)
	return p
}

// ForgetPrefix drops what a provider was given, for a test or for an
// operator asking for the rule to be applied again.
func ForgetPrefix(provider string) { prefixesTaken.Delete(provider) }

// normalizePrefix is a prefix in the form a model id can carry: letters,
// digits and the dashes inside a provider id, lower case.
func normalizePrefix(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimSuffix(s, sep)
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-', r == '_', r == '.':
			// the id's own separators all become the one a model id uses,
			// so "some_long_name" reads as one name rather than losing its
			// word boundaries
			b.WriteRune('-')
		}
	}
	// a leading or trailing dash would read as part of the model
	return strings.Trim(b.String(), sep)
}

// derivePrefix is the namespace a provider is served under: its own id,
// which is the name its vendor is known by and the one an operator reads
// in a model name.
//
// An id with characters a model id cannot carry is reduced to the ones it
// can, because a prefix that makes a model name unparseable helps nobody.
func derivePrefix(provider string) string {
	id := strings.ToLower(strings.TrimSpace(provider))
	if p := knownPrefixes[id]; p != "" {
		return p
	}
	if p := normalizePrefix(id); p != "" {
		return p
	}
	// no usable characters at all: a name is still needed, or every model
	// of this provider would answer for the bare id
	return "p"
}

// ProviderModelName is the relay name of one of a provider models: the
// provider id, a dash, and the model own id.
func ProviderModelName(prefix, model string) string {
	return prefix + sep + model
}

// modelOfPrefix is the model own id inside a relay name, with the prefix
// the channel records taken off. It is the only correct way to do this:
// splitting on the first dash turns
// "workbuddy-ai-glm-5.3" into "ai-glm-5.3".
func modelOfPrefix(name, prefix string) (string, bool) {
	if prefix == "" {
		return name, true
	}
	head := prefix + sep
	if !strings.HasPrefix(name, head) {
		return name, false
	}
	return strings.TrimPrefix(name, head), true
}

// prefixIsShadowed says whether prefix is another provider id with a dash
// after it, so that taking it off a name would leave a fragment that is the
// rest of that other id.
//
// It exists because "workbuddy" is a string prefix of "workbuddy-ai-glm-5.3"
// but not its namespace: the model there is "glm-5.3" under "workbuddy-ai".
// Registration never hits this — the channel records the prefix it used — but
// a caller that guessed one should be told rather than served a wrong name.
func prefixIsShadowed(prefix string, others []string) bool {
	for _, other := range others {
		if other != prefix && strings.HasPrefix(other, prefix+sep) {
			return true
		}
	}
	return false
}

// prefixClash is the models of other channels a registration would take
// over. It is checked before writing, because a collision is silent: the
// ability table simply gets a second row for the same model id, and
// routing starts picking between two vendors for one name.
func prefixClash(models []string, selfChannelID int) ([]string, error) {
	all, err := model.GetAllChannels(0, 0, true, true)
	if err != nil {
		return nil, fmt.Errorf("read the channels: %w", err)
	}
	mine := map[string]bool{}
	for _, m := range models {
		mine[m] = true
	}
	seen := map[string]bool{}
	var clash []string
	for _, ch := range all {
		if ch.Id == selfChannelID {
			continue
		}
		for _, m := range ch.GetModels() {
			m = strings.TrimSpace(m)
			if m == "" || !mine[m] || seen[m] {
				continue
			}
			seen[m] = true
			clash = append(clash, fmt.Sprintf("%s (channel %d: %s)", m, ch.Id, ch.Name))
		}
	}
	return clash, nil
}

// registeredPrefix is the namespace a provider's channels actually carry,
// read back from them rather than worked out again.
//
// It is not PrefixFor: that says what a registration made *now* would use,
// while a channel made before the rule changed still answers under the name
// it was given. A console that shows the names a client must ask for has to
// read the channel, or it prints a name the relay does not answer.
//
// Empty means no channel of this provider is namespaced at all.
func registeredPrefix(provider string) string {
	channels := providerChannels(provider)
	for _, ch := range channels {
		if ch.Prefix != "" {
			return ch.Prefix
		}
	}
	return ""
}
