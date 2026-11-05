package pluginreg

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// A channel registered before the old abbreviation rule carries the old
// prefix; one registered before there were namespaces at all carries none.
// They read the same in the channel, and need opposite treatment.
func TestCarriesPrefixTellsTheTwoRegistrationsApart(t *testing.T) {
	assert.True(t, carriesPrefix([]string{"wb:glm-5.3", "wb:hy3"}, "wb"))
	assert.False(t, carriesPrefix([]string{"glm-5.3", "hy3"}, "wb"))
	// nothing to look for is nothing found
	assert.False(t, carriesPrefix([]string{"glm-5.3"}, ""))
}

// The namespace a provider's channels actually carry is read from them, not
// worked out again: a channel made under the old rule still answers under the
// name it was given, and a console that prints the new one lies.
func TestSplitKnownPrefixHandlesBothSpellings(t *testing.T) {
	bare, ok := splitKnownPrefix("workbuddy-glm-5.3", "workbuddy")
	assert.True(t, ok)
	assert.Equal(t, "glm-5.3", bare)

	bare, ok = splitKnownPrefix("wb:glm-5.3", "wb")
	assert.True(t, ok)
	assert.Equal(t, "glm-5.3", bare)

	// an id that does not start with the prefix is its own name
	bare, ok = splitKnownPrefix("glm-5.3", "workbuddy")
	assert.False(t, ok)
	assert.Equal(t, "glm-5.3", bare)
}
