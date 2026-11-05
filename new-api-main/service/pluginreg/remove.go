package pluginreg

// Taking an account out of a provider.
//
// An account exists in two places: the plugin's sign-in store, and the
// channel that serves it. Dropping it from one and not the other leaves a
// channel key pointing at a sign-in nobody can renew, or a sign-in no channel
// can use. So one call does both, and says what it did to the channel.

import (
	"context"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/pluginhost"
)

// RemoveResult is what taking an account out came to.
type RemoveResult struct {
	Provider string `json:"provider"`
	Account  string `json:"account"`
	// Channels are the channels the account was taken out of.
	Channels []int `json:"channels"`
	// Removed are the channels that went with it: a channel serving only this
	// account has nothing left to serve, and a row that answers nothing is
	// worse than no row at all.
	Removed []int `json:"removed"`
	// SignedOut says the plugin's own record of it is gone too.
	SignedOut bool `json:"signed_out"`
}

// RemoveAccount drops one account: its place in every channel that serves
// it, and then its sign-in.
//
// The channels go first on purpose. The plugin's record is what every later
// step reads — the health sync, the renewal worker, the next registration —
// so it is the last thing to go: a call that fails between the two leaves the
// account out of service rather than half-removed, and running it again
// finishes the job.
func RemoveAccount(ctx context.Context, provider, account string) (*RemoveResult, error) {
	provider = strings.TrimSpace(provider)
	account = strings.TrimSpace(account)
	if provider == "" {
		return nil, fmt.Errorf("no provider named")
	}
	if account == "" {
		return nil, fmt.Errorf("name the account to remove")
	}
	res := &RemoveResult{Provider: provider, Account: account}

	// both shapes a channel can take: the pool of the provider's accounts,
	// and the one account's own channel when it was registered apart
	for _, tag := range []string{TagFor(provider, account), TagFor(provider, "")} {
		channels, err := model.GetChannelsByTag(tag, true, true)
		if err != nil {
			return nil, fmt.Errorf("look up channel %q: %w", tag, err)
		}
		for _, ch := range channels {
			removed, err := removeFromChannel(ch, account)
			if err != nil {
				return nil, err
			}
			res.Channels = append(res.Channels, ch.Id)
			if removed {
				res.Removed = append(res.Removed, ch.Id)
			}
		}
	}

	if err := pluginhost.SignOut(ctx, provider, account); err != nil {
		return res, fmt.Errorf("the account's channels were updated, but the plugin would not drop its sign-in: %w", err)
	}
	res.SignedOut = true

	model.InitChannelCache()
	return res, nil
}

// removeFromChannel takes one account out of a channel and saves it, and
// reports whether that left the channel with nothing and deleted it.
func removeFromChannel(ch *model.Channel, account string) (bool, error) {
	kept, found := pruneAccount(ch, account)
	if !found {
		// the channel never held this account: nothing to take out
		return false, nil
	}
	if len(kept) == 0 {
		// the last account it had: the row can serve nothing now, and the
		// provider's page says "no channel yet" so the operator can register
		// it fresh once an account is signed in again
		if err := ch.Delete(); err != nil {
			return false, fmt.Errorf("delete channel %d, which had no account left: %w", ch.Id, err)
		}
		return true, nil
	}
	if err := ch.Update(); err != nil {
		return false, fmt.Errorf("update channel %d: %w", ch.Id, err)
	}
	return false, nil
}

// pruneAccount takes one account out of a channel's key list, in memory, and
// gives back the keys that remain plus whether the account was in it.
//
// A pooled channel keeps serving its other accounts: only this key goes, and
// the status list is rebuilt for the indices the remaining keys now have, so
// an account that was resting stays resting and one that was fine stays fine.
func pruneAccount(ch *model.Channel, account string) ([]string, bool) {
	keys := ch.GetKeys()
	kept := make([]string, 0, len(keys))
	status := make(map[int]int, len(keys))
	disabledReason := map[int]string{}
	disabledTime := map[int]int64{}
	found := false
	for i, key := range keys {
		if strings.TrimSpace(key) == account {
			found = true
			continue
		}
		next := len(kept)
		kept = append(kept, key)
		if s, ok := ch.ChannelInfo.MultiKeyStatusList[i]; ok {
			status[next] = s
		}
		if reason, ok := ch.ChannelInfo.MultiKeyDisabledReason[i]; ok {
			disabledReason[next] = reason
		}
		if at, ok := ch.ChannelInfo.MultiKeyDisabledTime[i]; ok {
			disabledTime[next] = at
		}
	}
	if !found {
		return kept, false
	}

	ch.Key = strings.Join(kept, "\n")
	ch.ChannelInfo.MultiKeyStatusList = status
	ch.ChannelInfo.MultiKeyDisabledReason = disabledReason
	ch.ChannelInfo.MultiKeyDisabledTime = disabledTime
	// re-derives the count, the mode, and whether it is pooled at all: two
	// keys left is a pool, one is a plain channel with its key in the field
	setMultiKey(ch, kept)
	if ch.ChannelInfo.MultiKeyPollingIndex >= len(kept) {
		ch.ChannelInfo.MultiKeyPollingIndex = 0
	}
	return kept, true
}
