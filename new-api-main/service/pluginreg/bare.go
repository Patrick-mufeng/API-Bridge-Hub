package pluginreg

import (
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

// A model id without a namespace ("glm-5.3") is served as well as the
// namespaced one ("wb:glm-5.3"), because a client that a vendor's own docs
// name a model to should not have to learn this hub's spelling. The bare id
// is what a *group* answers to: every provider serving that model id is a
// member, and this hub routes between them.
//
// The routing is the relay's own: an ability row is (group, model, channel),
// and GetChannel takes the highest priority first, falling through to the
// next only on a retry. So a group whose members carry different priorities
// is "the best one that answers, else the next" — which is what an operator
// configuring priorities asked for. Weight decides between members sharing a
// priority.

// BareIDs are the ids a batch of namespaced model names answer to as well:
// workbuddy-glm-5.3 → glm-5.3.
//
// The prefix is the channel own, passed in rather than found by splitting:
// "workbuddy-ai-glm-5.3" cut at its first dash is "ai-glm-5.3", which is a
// model nobody serves.
func BareIDs(models []string, prefix string) []string {
	out := make([]string, 0, len(models))
	seen := map[string]bool{}
	for _, m := range models {
		m = strings.TrimSpace(m)
		if m == "" {
			continue
		}
		bare, ok := modelOfPrefix(m, prefix)
		if !ok {
			// a model with no prefix of this channel is its own id: there
			// is nothing to publish besides what the channel already has
			continue
		}
		if bare == "" || seen[bare] {
			continue
		}
		seen[bare] = true
		out = append(out, bare)
	}
	return out
}

// PublishBare makes a channel answer for the bare ids of its models too, so
// that a client asking for "glm-5.3" reaches whichever provider is first in
// line rather than having to know the namespace.
//
// It is written as extra ability rows, the mechanism the relay already
// routes by: the channel keeps its own namespaced models, and gains a row
// per bare id. Nothing about the channel's own model list changes, so a
// client asking for the namespaced id still reaches that one provider alone.
func PublishBare(channel *model.Channel, models []string) error {
	prefix := channel.GetOtherSettings().PluginPrefix
	bare := BareIDs(models, prefix)
	if len(bare) == 0 || channel.Id == 0 {
		return nil
	}
	groups := strings.Split(channel.Group, ",")
	rows := make([]model.Ability, 0, len(bare)*len(groups))
	for _, g := range groups {
		g = strings.TrimSpace(g)
		if g == "" {
			continue
		}
		for _, b := range bare {
			rows = append(rows, model.Ability{
				Group:     g,
				Model:     b,
				ChannelId: channel.Id,
				Enabled:   channel.Status == common.ChannelStatusEnabled,
				Priority:  channel.Priority,
				Weight:    uint(channel.GetWeight()),
				Tag:       channel.Tag,
			})
		}
	}
	if len(rows) == 0 {
		return nil
	}
	if err := model.AddAbilities(rows); err != nil {
		return fmt.Errorf("publish %s as a bare model id: %w", strings.Join(bare, ", "), err)
	}
	return nil
}

// BareMembers are the channels a bare id reaches, highest priority first:
// what an operator sees when they ask who serves "glm-5.3".
type BareMember struct {
	ChannelID int    `json:"channel_id"`
	Name      string `json:"name"`
	Priority  int64  `json:"priority"`
	Weight    uint   `json:"weight"`
	Enabled   bool   `json:"enabled"`
	// Rank is the tier this member belongs to: the lowest rank answers first,
	// and only a failure moves a request on to the next. Two members sharing
	// a rank are picked between by weight — and at equal weight, at random —
	// so they are alternatives, not a sequence.
	Rank int `json:"rank"`
}

// BareRoutes is every bare id this hub serves, and who serves it, ordered
// the way routing picks: the first member answers, the rest wait.
func BareRoutes() (map[string][]BareMember, error) {
	out := map[string][]BareMember{}
	channels, err := model.GetAllChannels(0, 0, true, true)
	if err != nil {
		return nil, err
	}
	for _, ch := range channels {
		if channelProvider(ch) == "" {
			continue
		}
		// a channel registered before the names were namespaced serves bare
		// ids already: cutting a prefix it never had would leave every one of
		// them out, and the page would say nothing is routed while requests
		// keep being answered
		prefix := ch.GetOtherSettings().PluginPrefix
		for _, m := range ch.GetModels() {
			name := strings.TrimSpace(m)
			bare, ok := modelOfPrefix(name, prefix)
			if !ok {
				continue
			}
			if bare == "" {
				continue
			}
			priority := int64(0)
			if ch.Priority != nil {
				priority = *ch.Priority
			}
			out[bare] = append(out[bare], BareMember{
				ChannelID: ch.Id, Name: ch.Name, Priority: priority,
				Weight:  uint(ch.GetWeight()),
				Enabled: ch.Status == common.ChannelStatusEnabled,
			})
		}
	}
	// the highest priority answers first, then the heaviest, and members
	// that tie on both are alternatives the relay picks between at random
	for bare := range out {
		members := out[bare]
		for i := 1; i < len(members); i++ {
			for j := i; j > 0; j-- {
				a, b := members[j-1], members[j]
				if a.Priority < b.Priority || (a.Priority == b.Priority && a.Weight < b.Weight) {
					members[j-1], members[j] = b, a
					continue
				}
				break
			}
		}
		// rank counts the distinct priorities: members sharing one are tried
		// together, not one after the other
		rank := -1
		last := int64(0)
		for i := range members {
			if i == 0 || members[i].Priority != last {
				rank++
				last = members[i].Priority
			}
			members[i].Rank = rank
		}
		out[bare] = members
	}
	return out, nil
}
