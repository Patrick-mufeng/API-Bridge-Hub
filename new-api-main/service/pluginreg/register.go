// Package pluginreg turns a plugin-host provider into new-api channels: one
// channel per plugin account, so the relay's own priority, weight, cooldown
// and automatic-disable carry each account the way they carry a key.
//
// The mapping is:
//
//	plugin provider id        -> Channel.BaseURL   (workbuddy)
//	plugin account (key)      -> Channel.Key       (workbuddy#xbpn48)
//	plugin's model list       -> Channel.Models    (prefixed, wb:glm-5.3)
//	model id <-> vendor's     -> Channel.ModelMapping
//	context windows           -> Channel.OtherSettings.ModelContextWindows
//
// A channel's tag is `plugin:<provider>:<account>`, so re-registering finds
// what it made before and leaves the operator's own edits to name, group and
// priority alone.
package pluginreg

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/pluginhost"
	"github.com/QuantumNous/new-api/relaykit/dto"
)

// TagPrefix marks a channel this package made.
const TagPrefix = "plugin:"

// Offer is what a provider can be registered as, for the console to show
// before anything is written.
type Offer struct {
	Provider string   `json:"provider"`
	Name     string   `json:"name"`
	SignedIn bool     `json:"signed_in"`
	Models   []string `json:"models"`
	Accounts []string `json:"accounts"`
	// Tag is the channel tag the provider's first account would be made
	// under, so the console can say what re-registering replaces.
	Tag string `json:"tag,omitempty"`
}

// Offers lists every provider the installed plugins serve, with what
// registering it would make. It reads the plugins, which may start their
// host: a page asks it on demand, never on a request's path.
func Offers(ctx context.Context) ([]Offer, error) {
	ps, err := pluginhost.Providers(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Offer, 0, len(ps))
	for _, p := range ps {
		accounts := make([]string, 0, 4)
		for k := range pluginhost.Auths(p.ID) {
			accounts = append(accounts, k)
		}
		sort.Strings(accounts)
		models := make([]string, 0, len(p.Models))
		for _, m := range p.Models {
			models = append(models, m.ID)
		}
		o := Offer{Provider: p.ID, Name: p.Name, SignedIn: p.SignedIn, Models: models, Accounts: accounts}
		if len(accounts) > 0 {
			o.Tag = TagFor(p.ID, accounts[0])
		}
		out = append(out, o)
	}
	return out, nil
}

// TagFor is the channel tag one account of a provider is kept under.
func TagFor(provider, account string) string {
	return TagPrefix + provider + ":" + account
}

// Options is how a provider is registered.
type Options struct {
	// Provider is the plugin's provider id (workbuddy).
	Provider string
	// Accounts names which accounts to pool; empty means every account the
	// plugin has signed in.
	Accounts []string
	// PerAccount makes one channel per account instead of one channel that
	// pools them. The default is the pool: a plugin already rotates its own
	// accounts, so a channel per account only adds rows to the list. One
	// channel per account is still what an operator wants when a vendor's
	// accounts get different rates, or when each is billed apart.
	PerAccount bool
	// ModelPrefix namespaces the exposed model names (wb:glm-5.3). Left
	// empty, one is worked out from the provider's id (see PrefixFor): a
	// provider registered with no namespace would answer for the same model
	// ids as any other serving them.
	ModelPrefix string
	// AllowClash registers even when another channel already serves one of
	// these model names. It is off by default: two channels answering one
	// model id makes routing pick between two vendors for one name, which is
	// never what registering a provider means.
	AllowClash bool
	// Group is the group the channels join; empty is "default".
	Group string
	// Priority and Weight are the channels' initial values; nil leaves the
	// column's default.
	Priority *int64
	Weight   *uint
	// Name is the channel name's prefix; empty is the provider's own name.
	Name string
}

// Result says what registering made.
type Result struct {
	// Lapsed are the accounts the plugin reports as signed out: their
	// channels are made, then switched off, so routing passes them by
	// instead of failing a request that has already gone out.
	Lapsed []string `json:"lapsed,omitempty"`
	// Health is one line saying how many accounts are usable.
	Health  string        `json:"health,omitempty"`
	Created []ChannelView `json:"created"`
	Updated []ChannelView `json:"updated"`
	// Skipped are accounts that were passed over and why.
	Skipped []string `json:"skipped,omitempty"`
}

// ChannelView is one channel as the console shows it.
type ChannelView struct {
	ID       int      `json:"id"`
	Name     string   `json:"name"`
	Account  string   `json:"account"`
	Models   []string `json:"models"`
	Tag      string   `json:"tag"`
	IsUpdate bool     `json:"is_update"`
}

// Register makes one channel per plugin account of opts.Provider, or updates
// the ones it made before, and syncs their model lists.
func Register(ctx context.Context, opts Options) (*Result, error) {
	provider := strings.TrimSpace(opts.Provider)
	if provider == "" {
		return nil, fmt.Errorf("no provider named")
	}
	ps, err := pluginhost.Providers(ctx)
	if err != nil {
		return nil, fmt.Errorf("read the plugins' providers: %w", err)
	}
	var found *pluginhost.Provider
	for i := range ps {
		if ps[i].ID == provider {
			found = &ps[i]
			break
		}
	}
	if found == nil {
		return nil, fmt.Errorf("no installed plugin serves the provider %q", provider)
	}
	accounts := opts.Accounts
	if len(accounts) == 0 {
		for k := range pluginhost.Auths(provider) {
			accounts = append(accounts, k)
		}
		sort.Strings(accounts)
	}
	if len(accounts) == 0 {
		// nothing signed in: a channel now, so the operator can see the
		// provider in the list, and its requests fail until an account is
		// signed in
		accounts = []string{""}
	}
	res := &Result{}
	if !opts.PerAccount {
		// one channel, the accounts as its keys: the plugin rotates them
		// itself, and new-api rotates the keys, so two rows per vendor would
		// be two lists of the same thing
		view, rerr := registerPool(found, accounts, opts)
		if rerr != nil {
			return nil, rerr
		}
		res.Created = append(res.Created, view)
		if health, herr := SyncHealth(ctx, provider); herr == nil {
			res.Health = DescribeHealth(health)
			for _, h := range health {
				if !h.Healthy {
					res.Lapsed = append(res.Lapsed, h.Account)
				}
			}
		}
		publishBare(res)
		model.InitChannelCache()
		return res, nil
	}
	for _, account := range accounts {
		view, err := registerOne(found, account, opts)
		if err != nil {
			res.Skipped = append(res.Skipped, fmt.Sprintf("%s: %v", displayAccount(provider, account), err))
			continue
		}
		if view.IsUpdate {
			res.Updated = append(res.Updated, view)
		} else {
			res.Created = append(res.Created, view)
		}
	}
	if len(res.Created) == 0 && len(res.Updated) == 0 {
		if len(res.Skipped) > 0 {
			return res, fmt.Errorf("no channel was made: %s", strings.Join(res.Skipped, "; "))
		}
		return res, fmt.Errorf("no account to register for %s", provider)
	}
	// The channels exist; now find out which of their accounts actually work.
	// A subscription pool is routinely part sign, and a channel whose account
	// lapsed answers 401 on every request that picks it: switching those off
	// here is what makes the first request after registering succeed rather
	// than fail once per dead account.
	if health, herr := SyncHealth(ctx, provider); herr == nil {
		res.Health = DescribeHealth(health)
		for _, h := range health {
			if !h.Healthy {
				res.Lapsed = append(res.Lapsed, h.Account)
			}
		}
	}
	publishBare(res)
	model.InitChannelCache()
	return res, nil
}

// publishBare makes each channel that was just made or updated answer for
// the bare ids of its models too, so a client asking for "glm-5.3" reaches
// whichever provider is first in line without knowing the namespace.
//
// The channel's own model list is what is read, not the plugin's: by the
// time this runs the channel carries the namespaced ids it will serve, and
// that is the list the bare ids have to come from.
func publishBare(res *Result) {
	for _, view := range append(append([]ChannelView{}, res.Created...), res.Updated...) {
		if view.ID == 0 {
			continue
		}
		ch, err := model.GetChannelById(view.ID, true)
		if err != nil || ch == nil {
			continue
		}
		_ = PublishBare(ch, ch.GetModels())
	}
}

func displayAccount(provider, account string) string {
	if account == "" {
		return provider + " (no account signed in)"
	}
	return account
}

// registerOne makes or updates the channel for one account.
// registerPool makes the one channel a provider is served by, with its
// accounts as that channel's keys.
//
// The plugin already rotates its accounts; new-api rotates a multi-key
// channel's keys with a per-key cooldown. Putting the accounts here rather
// than in a channel each is what keeps the channel list one row per vendor
// while still failing over from a rate-limited account to the next.
//
// A channel with no account signed in is still made, with an empty key: it
// shows up in the list as the vendor it is, and its requests fail until an
// account is added — which is a better answer than the vendor vanishing.
func registerPool(p *pluginhost.Provider, accounts []string, opts Options) (ChannelView, error) {
	prefix := PrefixFor(p.ID, opts.ModelPrefix)
	models, mapping := namespace(p.Models, prefix, sep)
	if len(models) == 0 {
		return ChannelView{}, fmt.Errorf("its plugin lists no model")
	}
	exposed := modelIDs(models)
	// the channel this provider already has, if any: re-registering it must
	// not count its own models as somebody else's
	tag := TagFor(p.ID, "")
	self, err := model.GetChannelsByTag(tag, true, true)
	if err != nil {
		return ChannelView{}, fmt.Errorf("look up channel by tag: %w", err)
	}
	selfID := 0
	if len(self) > 0 {
		selfID = self[0].Id
	}
	clash, cerr := prefixClash(exposed, selfID)
	if cerr != nil {
		return ChannelView{}, cerr
	}
	if len(clash) > 0 && !opts.AllowClash {
		return ChannelView{}, fmt.Errorf("these model names are already served by another channel, so a request for one would go to either: %s", strings.Join(clash, "; "))
	}
	name := strings.TrimSpace(opts.Name)
	if name == "" {
		name = p.Name
	}
	group := strings.TrimSpace(opts.Group)
	if group == "" {
		group = "default"
	}
	baseURL := p.ID

	keys := make([]string, 0, len(accounts))
	for _, a := range accounts {
		if strings.TrimSpace(a) != "" {
			keys = append(keys, a)
		}
	}
	key := strings.Join(keys, "\n")

	var mappingPtr *string
	if len(mapping) > 0 {
		encoded, err := common.Marshal(mapping)
		if err != nil {
			return ChannelView{}, fmt.Errorf("encode model mapping: %w", err)
		}
		s := string(encoded)
		mappingPtr = &s
	}
	windows := contextWindows(models)

	// an account signed in since the last time turns its key back on; one
	// that lapsed stays off until the health sync says otherwise
	channels := self
	view := ChannelView{Name: name, Models: exposed, Tag: tag}
	if len(keys) > 0 {
		view.Account = strings.Join(keys, ", ")
	}
	if len(channels) > 0 {
		channel := channels[0]
		channel.Name = name
		channel.Key = key
		channel.Type = constant.ChannelTypePluginProvider
		channel.BaseURL = &baseURL
		channel.Models = strings.Join(exposed, ",")
		channel.ModelMapping = mappingPtr
		channel.Status = common.ChannelStatusEnabled
		channel.Tag = &tag
		if strings.TrimSpace(channel.Group) == "" {
			channel.Group = group
		}
		if opts.Priority != nil && channel.Priority == nil {
			channel.Priority = opts.Priority
		}
		if opts.Weight != nil && channel.Weight == nil {
			channel.Weight = opts.Weight
		}
		settings := channel.GetOtherSettings()
		settings.ModelContextWindows = windows
		settings.PluginProvider = p.ID
		settings.PluginPrefix = prefix
		channel.SetOtherSettings(settings)
		setMultiKey(channel, keys)
		if err := channel.Update(); err != nil {
			return ChannelView{}, fmt.Errorf("update channel %d: %w", channel.Id, err)
		}
		view.ID = channel.Id
		view.IsUpdate = true
		return view, nil
	}

	channel := model.Channel{
		Type:         constant.ChannelTypePluginProvider,
		Name:         name,
		Key:          key,
		BaseURL:      &baseURL,
		Models:       strings.Join(exposed, ","),
		Group:        group,
		Status:       common.ChannelStatusEnabled,
		Tag:          &tag,
		ModelMapping: mappingPtr,
		Priority:     opts.Priority,
		Weight:       opts.Weight,
	}
	{
		settings := channel.GetOtherSettings()
		settings.ModelContextWindows = windows
		settings.PluginProvider = p.ID
		settings.PluginPrefix = prefix
		channel.SetOtherSettings(settings)
	}
	setMultiKey(&channel, keys)
	if err := channel.Insert(); err != nil {
		return ChannelView{}, fmt.Errorf("make the channel: %w", err)
	}
	view.ID = channel.Id
	return view, nil
}

// setMultiKey makes the channel pool its accounts, in the mode that shares
// requests out evenly: a pool of subscriptions is spent evenly by design.
func setMultiKey(channel *model.Channel, keys []string) {
	if len(keys) < 2 {
		// one account needs no rotation, and a single-key channel keeps the
		// key in the field operators expect to find it in
		channel.ChannelInfo.IsMultiKey = false
		channel.ChannelInfo.MultiKeySize = 0
		channel.ChannelInfo.MultiKeyStatusList = nil
		return
	}
	channel.ChannelInfo.IsMultiKey = true
	channel.ChannelInfo.MultiKeyMode = constant.MultiKeyModePolling
	channel.ChannelInfo.MultiKeySize = len(keys)
	if channel.ChannelInfo.MultiKeyStatusList == nil {
		channel.ChannelInfo.MultiKeyStatusList = map[int]int{}
	}
	for i := range keys {
		if _, ok := channel.ChannelInfo.MultiKeyStatusList[i]; !ok {
			channel.ChannelInfo.MultiKeyStatusList[i] = common.ChannelStatusEnabled
		}
	}
}

func registerOne(p *pluginhost.Provider, account string, opts Options) (ChannelView, error) {
	prefix := PrefixFor(p.ID, opts.ModelPrefix)
	models, mapping := namespace(p.Models, prefix, sep)
	if len(models) == 0 {
		return ChannelView{}, fmt.Errorf("its plugin lists no model")
	}
	exposed := modelIDs(models)
	tag := TagFor(p.ID, account)
	// the channel this account already has, if any: re-registering it must
	// not count its own models as somebody else's
	self, err := model.GetChannelsByTag(tag, true, true)
	if err != nil {
		return ChannelView{}, fmt.Errorf("look up channel by tag: %w", err)
	}
	selfID := 0
	if len(self) > 0 {
		selfID = self[0].Id
	}
	// the channels of one provider answer under one namespace, so only
	// another provider's names can clash here
	clash, cerr := prefixClash(exposed, selfID)
	if cerr != nil {
		return ChannelView{}, cerr
	}
	if len(clash) > 0 && !opts.AllowClash {
		return ChannelView{}, fmt.Errorf("these model names are already served by another channel: %s", strings.Join(clash, "; "))
	}
	name := strings.TrimSpace(opts.Name)
	if name == "" {
		name = p.Name
	}
	if account != "" {
		name = name + " · " + shortAccount(p.ID, account)
	}
	group := strings.TrimSpace(opts.Group)
	if group == "" {
		group = "default"
	}
	baseURL := p.ID
	key := account

	var mappingPtr *string
	if len(mapping) > 0 {
		encoded, err := common.Marshal(mapping)
		if err != nil {
			return ChannelView{}, fmt.Errorf("encode model mapping: %w", err)
		}
		s := string(encoded)
		mappingPtr = &s
	}
	windows := contextWindows(models)

	existing := self
	view := ChannelView{Name: name, Account: account, Models: exposed, Tag: tag}
	if len(existing) > 0 {
		channel := existing[0]
		channel.Name = name
		channel.Key = key
		channel.Type = constant.ChannelTypePluginProvider
		channel.BaseURL = &baseURL
		channel.Models = strings.Join(exposed, ",")
		channel.ModelMapping = mappingPtr
		channel.Status = common.ChannelStatusEnabled
		channel.Tag = &tag
		if strings.TrimSpace(channel.Group) == "" {
			channel.Group = group
		}
		if opts.Priority != nil && channel.Priority == nil {
			channel.Priority = opts.Priority
		}
		if opts.Weight != nil && channel.Weight == nil {
			channel.Weight = opts.Weight
		}
		settings := channel.GetOtherSettings()
		settings.ModelContextWindows = windows
		settings.PluginProvider = p.ID
		settings.PluginPrefix = prefix
		channel.SetOtherSettings(settings)
		if err := channel.Update(); err != nil {
			return ChannelView{}, fmt.Errorf("update channel %d: %w", channel.Id, err)
		}
		view.ID = channel.Id
		view.IsUpdate = true
		return view, nil
	}

	channel := model.Channel{
		Type:         constant.ChannelTypePluginProvider,
		Name:         name,
		Key:          key,
		BaseURL:      &baseURL,
		Models:       strings.Join(exposed, ","),
		Group:        group,
		Status:       common.ChannelStatusEnabled,
		Tag:          &tag,
		ModelMapping: mappingPtr,
		Priority:     opts.Priority,
		Weight:       opts.Weight,
		CreatedTime:  common.GetTimestamp(),
	}
	channel.ChannelInfo = model.ChannelInfo{}
	settings := channel.GetOtherSettings()
	settings.ModelContextWindows = windows
	settings.PluginProvider = p.ID
	settings.PluginPrefix = prefix
	channel.SetOtherSettings(settings)
	if err := model.BatchInsertChannels([]model.Channel{channel}); err != nil {
		return ChannelView{}, fmt.Errorf("create channel: %w", err)
	}
	made, err := model.GetChannelsByTag(tag, true, true)
	if err == nil && len(made) > 0 {
		view.ID = made[0].Id
	}
	return view, nil
}

// namespace maps the plugin's models to the names the relay exposes, and
// the reverse mapping that restores the vendor's id on the way out.
// namespace gives each model the relay name the channel will serve it under,
// and the mapping back to the vendor own id.
//
// The mapping is what the relay uses to ask the vendor for the right model:
// a client asks for "workbuddy-glm-5.3" and the vendor is asked for
// "glm-5.3".
func namespace(models []pluginhost.Model, prefix, sep string) ([]pluginhost.Model, map[string]string) {
	out := make([]pluginhost.Model, 0, len(models))
	mapping := map[string]string{}
	for _, m := range models {
		if prefix != "" {
			name := ProviderModelName(prefix, m.ID)
			mapping[name] = m.ID
			m.ID = name
		}
		out = append(out, m)
	}
	return out, mapping
}

// modelIDs is the ids of some models, in order.
func modelIDs(models []pluginhost.Model) []string {
	out := make([]string, 0, len(models))
	for _, m := range models {
		out = append(out, m.ID)
	}
	return out
}

// contextWindows is what each exposed model's context budget is, which the
// relay shows and uses to size a request.
func contextWindows(models []pluginhost.Model) map[string]dto.ModelContextWindow {
	out := make(map[string]dto.ModelContextWindow, len(models))
	for _, m := range models {
		if m.Context == 0 && m.Output == 0 {
			continue
		}
		out[m.ID] = dto.ModelContextWindow{
			ContextLength:   m.Context,
			MaxOutputTokens: m.Output,
		}
	}
	return out
}

// shortAccount names an account the way a channel list can show it: the
// end of its plugin key, and the account's own name when the plugin gave
// one.
func shortAccount(provider, account string) string {
	name := strings.TrimPrefix(account, provider)
	name = strings.TrimPrefix(name, "#")
	if name == "" {
		return "default account"
	}
	return name
}
