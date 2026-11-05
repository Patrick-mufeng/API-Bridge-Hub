package pluginreg

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/pluginhost"
)

// AccountPage is one provider's own page: what it is, what its accounts are
// made of, and the two things an operator does to them — sign in, and press
// the vendor's daily check-in.
//
// It is the data the console's provider page shows, gathered in one call:
// an operator opening a subscription wants its accounts, their allowance and
// what a check-in would do, not four requests for the same thing.
type AccountPage struct {
	Provider string `json:"provider"`
	Name     string `json:"name"`
	APIRoot  string `json:"api_root,omitempty"`
	NPM      string `json:"npm,omitempty"`
	SignedIn bool   `json:"signed_in"`
	// Checkin says the plugin presses its vendor's daily check-in, and so
	// whether the button belongs on this page at all.
	Checkin bool `json:"checkin"`
	// Usage says the vendor reports allowance figures.
	Usage bool `json:"usage"`
	// Renews says the plugin renews sign-ins by itself.
	Renews bool `json:"renews"`
	// Accounts are its accounts, the provider's own first.
	Accounts []AccountView `json:"accounts"`
	// Channels are the channels this provider is served by.
	Channels []ProviderChannel `json:"channels,omitempty"`
}

// ProviderChannel is one channel serving a provider: the row this provider
// occupies in the relay's channel list, and whether it is on.
type ProviderChannel struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Tag      string `json:"tag,omitempty"`
	Prefix   string `json:"prefix,omitempty"`
	Models   int    `json:"models"`
	Enabled  bool   `json:"enabled"`
	Priority int64  `json:"priority"`
	Weight   uint   `json:"weight"`
	// Keys is how many accounts the channel pools, 0 for a plain one.
	Keys int `json:"keys"`
}

// Page is a provider's own page.
func Page(ctx context.Context, id string) (*AccountPage, error) {
	ps, err := pluginhost.Providers(ctx)
	if err != nil {
		return nil, err
	}
	var p *pluginhost.Provider
	for i := range ps {
		if ps[i].ID == id {
			p = &ps[i]
			break
		}
	}
	if p == nil {
		return nil, fmt.Errorf("no installed plugin serves the provider %q", id)
	}
	page := &AccountPage{
		Provider: p.ID, Name: p.Name, APIRoot: p.API, NPM: p.NPM,
		SignedIn: p.SignedIn, Checkin: p.Checkin, Usage: p.Usage, Renews: p.Renews,
	}
	auths := pluginhost.Auths(p.ID)
	keys := make([]string, 0, len(auths))
	for k := range auths {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	// the provider's own id first: that is the account a request naming none
	// goes as, so it is the one an operator looks for first
	sort.SliceStable(keys, func(i, j int) bool {
		if keys[i] == p.ID {
			return true
		}
		if keys[j] == p.ID {
			return false
		}
		return keys[i] < keys[j]
	})
	for _, k := range keys {
		a := auths[k]
		v := AccountView{Key: k, Label: accountLabel(k, a)}
		v.Type, _ = a["type"].(string)
		v.AccountID, _ = a["accountId"].(string)
		v.Enterprise, _ = a["enterpriseId"].(string)
		if n, ok := a["expires"].(float64); ok {
			v.Expires = int64(n)
		}
		attachAccountUsage(ctx, p.ID, k, &v)
		page.Accounts = append(page.Accounts, v)
	}
	page.Channels = providerChannels(p.ID)
	return page, nil
}

// providerChannels are the channels registered from a provider.
func providerChannels(provider string) []ProviderChannel {
	all, err := model.GetAllChannels(0, 0, true, true)
	if err != nil {
		return nil
	}
	var out []ProviderChannel
	for _, ch := range all {
		if channelProvider(ch) != provider {
			continue
		}
		settings := ch.GetOtherSettings()
		priority := int64(0)
		if ch.Priority != nil {
			priority = *ch.Priority
		}
		pc := ProviderChannel{
			ID: ch.Id, Name: ch.Name, Prefix: settings.PluginPrefix,
			Models: len(ch.GetModels()), Priority: priority,
			Weight:  uint(ch.GetWeight()),
			Enabled: ch.Status == 1,
		}
		if ch.Tag != nil {
			pc.Tag = *ch.Tag
		}
		if ch.ChannelInfo.IsMultiKey {
			pc.Keys = len(ch.GetKeys())
		}
		out = append(out, pc)
	}
	return out
}

// channelProvider is the plugin provider a channel is served by.
//
// The settings carry it, and so does the tag ("plugin:<provider>:<account>"):
// a channel registered before the settings were written has only the tag, and
// reading just one of them would leave that channel out of its provider's
// usage, its accounts and its page.
func channelProvider(ch *model.Channel) string {
	if p := ch.GetOtherSettings().PluginProvider; p != "" {
		return p
	}
	if ch.Tag == nil {
		return ""
	}
	rest, ok := strings.CutPrefix(*ch.Tag, TagPrefix)
	if !ok {
		return ""
	}
	provider, _, _ := strings.Cut(rest, ":")
	return provider
}

// CheckinResult is what a check-in did, for one account or for all of them.
type CheckinResult struct {
	Provider string `json:"provider"`
	// Accounts are what each account's check-in came to.
	Accounts []CheckinEntry `json:"accounts"`
	// Claimed is how many were checked in by this call.
	Claimed int `json:"claimed"`
	// Failed is how many the vendor turned away.
	Failed int `json:"failed"`
}

// CheckinEntry is one account's check-in.
type CheckinEntry struct {
	Account string `json:"account"`
	Label   string `json:"label,omitempty"`
	// Outcome is the plugin's word: claimed, done, ineligible, inactive,
	// captcha or failed.
	Outcome string  `json:"outcome"`
	Credit  float64 `json:"credit,omitempty"`
	Streak  int     `json:"streak,omitempty"`
	Message string  `json:"message,omitempty"`
	// Until is when the vendor's own day turns, so the answer stops holding.
	Until string `json:"until,omitempty"`
	// Day is the local day this result is for, set when it is remembered.
	Day   string `json:"day,omitempty"`
	Error string `json:"error,omitempty"`
}

// Checkin presses the vendor's daily check-in for a provider's accounts.
// account names one; "" does every account it has signed in.
//
// A vendor that hands out daily credits is a subscription whose allowance is
// partly the check-in: pressing it is what an operator does when an account
// runs low, and doing it for every account at once is what one button on the
// page should do.
func Checkin(ctx context.Context, provider, account string) (*CheckinResult, error) {
	ps, err := pluginhost.Providers(ctx)
	if err != nil {
		return nil, err
	}
	var p *pluginhost.Provider
	for i := range ps {
		if ps[i].ID == provider {
			p = &ps[i]
			break
		}
	}
	if p == nil {
		return nil, fmt.Errorf("no installed plugin serves the provider %q", provider)
	}
	if !p.Checkin {
		return nil, fmt.Errorf("%s has no daily check-in", p.Name)
	}
	accounts := []string{}
	if strings.TrimSpace(account) != "" {
		accounts = []string{account}
	} else {
		for k := range pluginhost.Auths(provider) {
			accounts = append(accounts, k)
		}
		sort.Strings(accounts)
	}
	if len(accounts) == 0 {
		return nil, fmt.Errorf("%s has no account signed in", p.Name)
	}
	out := &CheckinResult{Provider: provider}
	for _, a := range accounts {
		entry := CheckinEntry{Account: a, Label: shortAccount(provider, a)}
		c, cerr := pluginhost.AccountCheckin(ctx, provider, a)
		if cerr != nil {
			entry.Outcome = "failed"
			entry.Error = cerr.Error()
			out.Failed++
			out.Accounts = append(out.Accounts, entry)
			continue
		}
		entry.Outcome = c.Outcome
		entry.Credit = c.Credit
		entry.Streak = c.Streak
		entry.Message = c.Message
		entry.Until = c.Until
		switch c.Outcome {
		case "claimed", "done":
			out.Claimed++
		case "ineligible", "inactive", "captcha", "failed":
			out.Failed++
		}
		out.Accounts = append(out.Accounts, entry)
	}
	return out, nil
}
