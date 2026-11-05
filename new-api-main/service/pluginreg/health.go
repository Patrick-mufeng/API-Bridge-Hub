package pluginreg

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/pluginhost"

	"github.com/bytedance/gopkg/util/gopool"
)

// AccountHealth is what a plugin says of one account's sign-in.
//
// new-api routes by channel priority and weight, and knows nothing of a
// plugin's accounts: a channel whose account lapsed is chosen like any
// other, and the request fails there. Syncing health closes that loop — an
// account the plugin reports as signed out has its channel turned off, so
// routing passes it by instead of failing over after the fact.
type AccountHealth struct {
	Provider string `json:"provider"`
	Account  string `json:"account"`
	// ChannelID is the channel this account is served by, 0 when none.
	ChannelID int `json:"channel_id"`
	// KeyIndex is the account's position in that channel's key list, -1 when
	// the channel isn't pooled (its one key is the account).
	KeyIndex int `json:"key_index"`
	// SignIn is the plugin's word: "kept" (fine), "expired" (sign in again),
	// or "" when it said nothing.
	SignIn string `json:"sign_in,omitempty"`
	// Error is why, when the plugin gave a reason.
	Error string `json:"error,omitempty"`
	// Healthy is what routing should assume. A plugin that says nothing is
	// taken as healthy: an unknown reading is not a bad one.
	Healthy bool `json:"healthy"`
	// ChannelOn is the channel's status now, and Changed says this sync
	// moved it.
	ChannelOn bool `json:"channel_on"`
	Changed   bool `json:"changed"`
	// Plan is the allowance card's name, when the plugin reports one.
	Plan string `json:"plan,omitempty"`
	// Windows are the account's quota windows, as the plugin tells them.
	Windows []QuotaWindow `json:"windows,omitempty"`
}

// QuotaWindow is one of an account's allowance windows.
type QuotaWindow struct {
	Name     string  `json:"name"`
	Used     float64 `json:"used,omitempty"`
	Limit    float64 `json:"limit,omitempty"`
	Display  string  `json:"display,omitempty"`
	Unit     string  `json:"unit,omitempty"`
	ResetsAt string  `json:"resets_at,omitempty"`
}

// pluginAccounts is a provider's accounts as its plugin has them, in a
// stable order so two reads agree.
func pluginAccounts(provider string) []string {
	auths := pluginhost.Auths(provider)
	out := make([]string, 0, len(auths))
	for k := range auths {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// SyncHealth asks each plugin what it says of each of its accounts, and
// turns a channel off when its account's sign-in has lapsed (and back on
// when the plugin says it is fine again). It reports what it found either
// way.
//
// provider limits the sync to one provider; "" asks every installed one.
func SyncHealth(ctx context.Context, provider string) ([]AccountHealth, error) {
	ps, err := pluginhost.Providers(ctx)
	if err != nil {
		return nil, err
	}
	var out []AccountHealth
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for _, p := range ps {
		if provider != "" && p.ID != provider {
			continue
		}
		accounts := pluginAccounts(p.ID)
		if len(accounts) == 0 && provider != "" {
			out = append(out, AccountHealth{Provider: p.ID, Healthy: false,
				Error: "no account signed in"})
		}
		for _, account := range accounts {
			account := account
			wg.Add(1)
			sem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-sem }()
				h := readHealth(ctx, p.ID, account)
				mu.Lock()
				out = append(out, h)
				mu.Unlock()
			}()
		}
	}
	wg.Wait()

	// the channels are touched one at a time, outside the parallel reads
	for i := range out {
		applyHealth(&out[i])
	}
	model.InitChannelCache()
	return out, nil
}

// readHealth asks the plugin one account's usage, whose signIn field is
// what it says of the sign-in.
func readHealth(ctx context.Context, provider, account string) AccountHealth {
	h := AccountHealth{Provider: provider, Account: account, Healthy: true}
	h.KeyIndex = -1
	// the channel this account is served by: the pooled one for its
	// provider, or the per-account one when the provider was registered that
	// way
	for _, tag := range []string{TagFor(provider, ""), TagFor(provider, account)} {
		existing, err := model.GetChannelsByTag(tag, true, true)
		if err != nil || len(existing) == 0 {
			continue
		}
		ch := existing[0]
		h.ChannelID = ch.Id
		h.ChannelOn = ch.Status == common.ChannelStatusEnabled
		if ch.ChannelInfo.IsMultiKey {
			for i, key := range ch.GetKeys() {
				if strings.TrimSpace(key) == account {
					h.KeyIndex = i
					break
				}
			}
		}
		break
	}
	u, err := pluginhost.AccountUsage(ctx, provider, account)
	if err != nil {
		// a plugin that can't be asked proves nothing: left as it is
		h.Error = err.Error()
		return h
	}
	h.SignIn = strings.ToLower(strings.TrimSpace(u.SignIn))
	h.Error = u.Error
	h.Plan = u.Plan
	for _, w := range u.Windows {
		win := QuotaWindow{
			Name: w.Name, Limit: w.Limit,
			Display: w.Display, Unit: w.Unit, ResetsAt: w.ResetsAt,
		}
		if w.Used != nil {
			win.Used = *w.Used
		} else if w.Limit > 0 {
			win.Used = w.Amount / w.Limit * 100
		}
		h.Windows = append(h.Windows, win)
	}
	switch h.SignIn {
	case "expired":
		h.Healthy = false
	case "kept", "renewed":
		h.Healthy = true
	default:
		// nothing said: an unknown reading is not a bad one
		h.Healthy = true
	}
	return h
}

// spendShare is how full an account's allowance is, 0–100, as the fullest of
// its windows.
//
// The fullest, not an average: whatever runs out first is what will refuse the
// next request, and a weekly window with room left is no help when the
// five-hour one is at 98%. A window the plugin gave no figure for is skipped;
// no window at all means nothing is known, and routing keeps its own order.
func spendShare(windows []QuotaWindow) (float64, bool) {
	fullest, known := 0.0, false
	for _, w := range windows {
		if w.Used <= 0 {
			continue
		}
		if !known || w.Used > fullest {
			fullest, known = w.Used, true
		}
	}
	return fullest, known
}

// applyHealth moves what the account's health calls for.
//
// UpdateChannelStatus takes the key the request used: on a pooled channel it
// moves that one key and leaves the rest serving, and only turns the whole
// channel off once every key is out. On a one-account channel the row is the
// account, and the same call moves it.
//
// Turning a pooled channel off because one of its six accounts lapsed would
// take the other five out of service with it, which is the whole reason the
// accounts are pooled in one row.
func applyHealth(h *AccountHealth) {
	if h.ChannelID == 0 {
		return
	}
	ch, err := model.GetChannelById(h.ChannelID, true)
	if err != nil || ch == nil {
		return
	}
	pooled := ch.ChannelInfo.IsMultiKey && h.KeyIndex >= 0
	if pooled {
		// Record what the vendor says is spent, so routing can prefer an
		// account with room over one about to answer 429. The share is the
		// fullest of its windows: a five-hour window at 95% is what runs out
		// first, whatever the weekly one says.
		share, known := spendShare(h.Windows)
		if known {
			if ch.ChannelInfo.MultiKeyUsedShare == nil {
				ch.ChannelInfo.MultiKeyUsedShare = make(map[int]float64)
			}
			if ch.ChannelInfo.MultiKeyUsageAt == nil {
				ch.ChannelInfo.MultiKeyUsageAt = make(map[int]int64)
			}
			ch.ChannelInfo.MultiKeyUsedShare[h.KeyIndex] = share
			ch.ChannelInfo.MultiKeyUsageAt[h.KeyIndex] = common.GetTimestamp()
			if err := ch.SaveChannelInfo(); err != nil {
				common.SysLog(common.LogText("failed to record the allowance of channel #%d key %d: %v", h.ChannelID, h.KeyIndex, err))
			}
		}
	}
	switch {
	case !h.Healthy && (ch.Status == common.ChannelStatusEnabled || pooled):
		key := ""
		if pooled {
			key = h.Account
		}
		if model.UpdateChannelStatus(h.ChannelID, key, common.ChannelStatusAutoDisabled,
			"its plugin account's sign-in lapsed") {
			h.Changed = true
		}
	case h.Healthy && pooled:
		if model.UpdateChannelStatus(h.ChannelID, h.Account, common.ChannelStatusEnabled,
			"its plugin account signed in again") {
			h.Changed = true
		}
	case h.Healthy && ch.Status == common.ChannelStatusAutoDisabled:
		if model.UpdateChannelStatus(h.ChannelID, "", common.ChannelStatusEnabled,
			"its plugin account signed in again") {
			h.Changed = true
		}
	}
}

// SyncAllHealth keeps every plugin account's channel in step with what its
// plugin says, on a timer. It is what makes a hub that nobody opens still
// route around an account that lapsed overnight.
func SyncAllHealth(ctx context.Context) error {
	_, err := SyncHealth(ctx, "")
	return err
}

// syncCooldown keeps a burst of failing requests from turning into a burst of
// plugin asks. A 401 from one request is rarely alone: the other requests in
// flight hit it too, and each one would otherwise ask the plugin the same
// question within the same second.
const syncCooldown = 30 * time.Second

var (
	syncMu   sync.Mutex
	syncLast = map[string]time.Time{}
)

// SyncChannelHealthAfterFailure asks the plugin about the accounts behind one
// channel after a request failed on it with a sign-in or quota status.
//
// The timer alone is too slow for this: an account whose token lapsed in the
// night keeps answering requests as "the token is wrong" until the next
// five-minute pass moves it out. Doing it here means the second request
// already routes around it.
//
// It runs in the background and never fails the request: whatever the plugin
// says is a correction to routing, not a reason to turn a served reply into
// an error.
func SyncChannelHealthAfterFailure(channelID int) {
	if channelID == 0 {
		return
	}
	ch, err := model.GetChannelById(channelID, true)
	if err != nil || ch == nil {
		return
	}
	provider := channelProvider(ch)
	if provider == "" {
		return // not a plugin channel: nothing here can read its accounts
	}
	now := time.Now()
	syncMu.Lock()
	if last, ok := syncLast[provider]; ok && now.Sub(last) < syncCooldown {
		syncMu.Unlock()
		return
	}
	syncLast[provider] = now
	syncMu.Unlock()

	gopool.Go(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		list, err := SyncHealth(ctx, provider)
		if err != nil {
			common.SysLog(common.LogText("plugin health after a failed request (provider %s): %v", provider, err))
			return
		}
		common.SysLog(common.LogText("plugin health after a failed request (provider %s): %s", provider, DescribeHealth(list)))
	})
}

// DescribeHealth is one line per provider, for a log: how many of its
// accounts are healthy, and how many channels they add up to.
func DescribeHealth(list []AccountHealth) string {
	byProvider := map[string][2]int{}
	for _, h := range list {
		c := byProvider[h.Provider]
		c[1]++
		if h.Healthy {
			c[0]++
		}
		byProvider[h.Provider] = c
	}
	// the channels the accounts add up to: a pool of six is one row
	channels := map[string]bool{}
	for _, h := range list {
		if h.ChannelID != 0 {
			channels[fmt.Sprint(h.ChannelID)] = true
		}
	}
	parts := make([]string, 0, len(byProvider))
	for p, c := range byProvider {
		parts = append(parts, fmt.Sprintf("%s %d/%d", p, c[0], c[1]))
	}
	out := strings.Join(parts, ", ")
	if len(channels) > 0 {
		out += fmt.Sprintf(" · %d channel(s)", len(channels))
	}
	return out
}
