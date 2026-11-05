package pluginreg

import (
	"testing"

	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
)

// A channel says which provider serves it in two places, and either one is
// enough: a channel registered before the settings were written has only its
// tag, and leaving it out would drop it from its provider's usage.
func TestChannelProviderReadsSettingsOrTag(t *testing.T) {
	withSettings := func() *model.Channel {
		ch := &model.Channel{Id: 1}
		settings := ch.GetOtherSettings()
		settings.PluginProvider = "workbuddy"
		ch.SetOtherSettings(settings)
		return ch
	}
	tag := func(s string) *model.Channel {
		return &model.Channel{Id: 2, Tag: &s}
	}

	assert.Equal(t, "workbuddy", channelProvider(withSettings()))
	assert.Equal(t, "workbuddy", channelProvider(tag("plugin:workbuddy:")))
	assert.Equal(t, "workbuddy", channelProvider(tag("plugin:workbuddy:workbuddy#2apscn")))
	// another kind of channel is nobody's provider
	assert.Empty(t, channelProvider(tag("reverse-proxy:cline")))
	assert.Empty(t, channelProvider(&model.Channel{Id: 3}))
}

// A provider id with a dash in it survives the tag: workbuddy-ai is its own
// provider, not workbuddy's.
func TestChannelProviderKeepsADashedId(t *testing.T) {
	s := "plugin:workbuddy-ai:workbuddy-ai"
	assert.Equal(t, "workbuddy-ai", channelProvider(&model.Channel{Tag: &s}))
}
