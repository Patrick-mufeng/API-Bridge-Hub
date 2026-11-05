package pluginreg

import (
	"context"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/pluginhost"
)

// Migrating the model names a hub already serves.
//
// A hub registered before the names were "provider-model" serves "wb:glm-5.3"
// and friends. Renaming them is not cosmetic: a client that asks for the old
// name would stop working, so the old names are kept as bare aliases and the
// new ones become the channel own.
//
// The old prefix is read from what the channel records, never guessed: a
// channel says what namespace it was given, which is the only thing that can
// tell "wb:glm-5.3" from a model whose own id starts with "wb".

// PrefixMigrationEntry is one channel that was renamed.
type PrefixMigrationEntry struct {
	ChannelID int    `json:"channel_id"`
	Name      string `json:"name"`
	From      string `json:"from"`
	To        string `json:"to"`
	Models    int    `json:"models"`
	// Kept are the old names still served as bare aliases.
	Kept []string `json:"kept,omitempty"`
}

// PrefixMigration is what renaming every channel came to.
type PrefixMigration struct {
	// Dry, when set, means nothing was written.
	Dry      bool                   `json:"dry"`
	Migrated []PrefixMigrationEntry `json:"migrated"`
	// Skipped are channels left alone, and why.
	Skipped []string `json:"skipped,omitempty"`
}

// MigratePrefixes renames the models of every plugin channel to the
// "provider-model" form. With dry set it reports what it would do and writes
// nothing.
func MigratePrefixes(ctx context.Context, dry bool) (*PrefixMigration, error) {
	// the provider ids, for turning a provider into its prefix
	known := map[string]bool{}
	for _, p := range pluginhost.ProvidersWithAccounts() {
		known[p] = true
	}
	if ps, err := pluginhost.Providers(ctx); err == nil {
		for _, p := range ps {
			known[p.ID] = true
		}
	}

	all, err := model.GetAllChannels(0, 0, true, true)
	if err != nil {
		return nil, err
	}
	out := &PrefixMigration{Dry: dry}
	for _, ch := range all {
		if ch.Type != constant.ChannelTypePluginProvider {
			continue
		}
		settings := ch.GetOtherSettings()
		provider := settings.PluginProvider
		if provider == "" && ch.BaseURL != nil {
			provider = strings.TrimSpace(*ch.BaseURL)
		}
		if provider == "" {
			out.Skipped = append(out.Skipped, fmt.Sprintf("#%d %s: names no provider", ch.Id, ch.Name))
			continue
		}
		newPrefix := derivePrefix(provider)
		recorded := settings.PluginPrefix
		oldPrefix := recorded
		if oldPrefix == "" {
			// a channel from before prefixes were recorded: its names carry
			// the abbreviation the rule used then
			oldPrefix = legacyPrefixOf(provider)
		}
		if oldPrefix == newPrefix {
			out.Skipped = append(out.Skipped, fmt.Sprintf("#%d %s: already %s", ch.Id, ch.Name, newPrefix))
			continue
		}
		// a channel that records no prefix and carries none of the old
		// abbreviations serves the vendor's own ids: nothing to rename, but
		// the names still need a namespace before another provider can serve
		// the same model id without the two answering for one name
		unbaptised := recorded == "" && !carriesPrefix(ch.GetModels(), oldPrefix)

		// rename each namespaced model, and keep the old name as an alias
		models := ch.GetModels()
		renamed := make([]string, 0, len(models))
		mapping := map[string]string{}
		kept := make([]string, 0, len(models))
		changed := 0
		for _, m := range models {
			bare, ok := splitKnownPrefix(m, oldPrefix)
			if unbaptised {
				// the channel serves the vendor's own id: it is its own bare
				// name, and it is about to gain a namespace
				bare, ok = strings.TrimSpace(m), strings.TrimSpace(m) != ""
			}
			if !ok {
				// a model with no prefix of ours: left as it is
				renamed = append(renamed, m)
				continue
			}
			newName := ProviderModelName(newPrefix, bare)
			renamed = append(renamed, newName)
			mapping[newName] = bare
			// the old name still answers, as a bare alias, so a client
			// configured yesterday keeps working
			kept = append(kept, m)
			changed++
		}
		if changed == 0 {
			out.Skipped = append(out.Skipped, fmt.Sprintf("#%d %s: no namespaced model to rename", ch.Id, ch.Name))
			continue
		}
		from := oldPrefix
		if unbaptised {
			// there was no namespace to move off
			from = ""
		}
		entry := PrefixMigrationEntry{
			ChannelID: ch.Id, Name: ch.Name,
			From: from, To: newPrefix,
			Models: changed, Kept: kept,
		}
		out.Migrated = append(out.Migrated, entry)
		if dry {
			continue
		}
		// write it
		ch.Models = strings.Join(renamed, ",")
		if len(mapping) > 0 {
			if b, err := common.Marshal(mapping); err == nil {
				s := string(b)
				ch.ModelMapping = &s
			}
		}
		st := ch.GetOtherSettings()
		st.PluginPrefix = newPrefix
		if st.PluginProvider == "" {
			st.PluginProvider = provider
		}
		ch.SetOtherSettings(st)
		if err := ch.Update(); err != nil {
			out.Skipped = append(out.Skipped, fmt.Sprintf("#%d %s: %v", ch.Id, ch.Name, err))
			continue
		}
		// the old names keep answering as bare ids
		var rows []model.Ability
		for _, old := range kept {
			bare, ok := bareOfKeep(old, oldPrefix, unbaptised)
			if !ok {
				continue
			}
			for _, group := range strings.Split(ch.Group, ",") {
				group = strings.TrimSpace(group)
				if group == "" {
					continue
				}
				rows = append(rows, model.Ability{
					Group: group, Model: bare, ChannelId: ch.Id,
					Enabled:  ch.Status == common.ChannelStatusEnabled,
					Priority: ch.Priority, Weight: uint(ch.GetWeight()), Tag: ch.Tag,
				})
			}
		}
		_ = model.AddAbilities(rows)
	}
	if !dry {
		model.InitChannelCache()
	}
	return out, nil
}

// splitKnownPrefix is modelOfPrefix for a name written under a prefix whose
// separator may be the one an older rule used.
//
// The names this hub served before were "wb:glm-5.3": the prefix, a colon,
// the model. The rule now writes a dash. A migration has to read both, and it
// knows the prefix already, so it can tell which it is looking at.
func splitKnownPrefix(name, prefix string) (string, bool) {
	if bare, ok := modelOfPrefix(name, prefix); ok {
		return bare, true
	}
	if prefix == "" {
		return name, true
	}
	old := prefix + ":"
	if strings.HasPrefix(name, old) {
		return strings.TrimPrefix(name, old), true
	}
	return name, false
}

// legacyPrefixOf is the abbreviation the first rule gave a provider, for a
// channel that records none.
func legacyPrefixOf(provider string) string {
	legacy := map[string]string{
		"workbuddy": "wb", "cline": "cl", "cmdgo": "cg",
		"qoder": "qd", "trae": "tr", "workbuddy-ai": "wbai",
	}
	if p, ok := legacy[provider]; ok {
		return p
	}
	return ""
}

// carriesPrefix says whether any of a channel's models already starts with
// the prefix the old rule gave its provider.
//
// It tells "registered when the names were abbreviated" from "registered
// before there were namespaces at all": the two look the same in the channel,
// which records no prefix in either case, and they need opposite treatment —
// one is renamed off its abbreviation, the other gains a namespace it never
// had.
func carriesPrefix(models []string, prefix string) bool {
	if prefix == "" {
		return false
	}
	for _, m := range models {
		if _, ok := splitKnownPrefix(strings.TrimSpace(m), prefix); ok {
			return true
		}
	}
	return false
}

// bareOfKeep is the bare id an old name still answers as.
//
// A channel that had a namespace kept its old names as they were written
// ("wb:glm-5.3"), and the prefix they carry comes off. A channel that never
// had one serves the vendor's own ids already ("glm-5.3"), so its old names
// are the bare ids themselves — reading them through a prefix finds nothing,
// and the aliases would silently never be published.
func bareOfKeep(name, oldPrefix string, unbaptised bool) (string, bool) {
	if unbaptised {
		trimmed := strings.TrimSpace(name)
		return trimmed, trimmed != ""
	}
	return splitKnownPrefix(name, oldPrefix)
}
