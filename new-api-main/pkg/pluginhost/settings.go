package pluginhost

import (
	"context"

	"github.com/QuantumNous/new-api/pkg/pluginhost/support/settings"
)

// Settings is what the plugin host itself is told to do: which npm registry
// plugins come from, the options given to plugins, and whether the host runs
// at all.
type Settings = settings.Settings

// ReadSettings is the host's settings as they are on disk.
func ReadSettings() Settings { return settings.Load() }

// SaveSettings keeps them.
func SaveSettings(s Settings) error { return settings.Save(s) }

// ChosenOptions is the per-provider switches the user set, by provider id
// and option key: what a plugin reads of its own options.
func ChosenOptions() map[string]map[string]bool {
	out := map[string]map[string]bool{}
	for provider, opts := range settings.Load().PluginOptions {
		m := make(map[string]bool, len(opts))
		for k, v := range opts {
			if b, ok := v.(bool); ok {
				m[k] = b
			}
		}
		if len(m) > 0 {
			out[provider] = m
		}
	}
	return out
}

// SetChosenOption keeps one provider switch.
func SetChosenOption(provider, key string, on bool) error {
	s := settings.Load()
	if s.PluginOptions == nil {
		s.PluginOptions = map[string]map[string]any{}
	}
	if s.PluginOptions[provider] == nil {
		s.PluginOptions[provider] = map[string]any{}
	}
	s.PluginOptions[provider][key] = on
	if err := settings.Save(s); err != nil {
		return err
	}
	return SetProviderOptions(context.Background())
}
