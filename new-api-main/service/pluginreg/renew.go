package pluginreg

import (
	"context"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/pluginhost"
)

// Renewal, and the order it runs in.
//
// A sign-in about to lapse is renewed before it does, so an account a vendor
// expires nightly still serves in the morning.
//
// How that happens depends on the plugin, and both ways are covered by one
// call. A plugin that declares auth.refresh renews on request, and the host
// says so (KeptSignedIn.Renewed). A plugin that does not — WorkBuddy, for
// one — renews inside its loader as it answers, so any call on the account
// renews it, and the sign-in expiry moving is what says it did. Measuring
// the expiry before and after catches both without knowing which a plugin is.
//
// This is why the renewal runs before the health sync and not after it: the
// health sync asks each account its allowance, and that call renews the
// account as a side effect. Run second, renewal would find nothing due and
// the hub would be renewed by a bookkeeping pass nobody asked.

// renewEvery is how often a renewal is attempted. A vendor whose token lasts
// an hour and whose lead is five minutes needs a look oftener than the
// health sync, which is why these are two timers and not one.
var renewEvery = 2 * time.Minute

// renewLead is how long before a sign-in ends it is worth asking.
const renewLead = 10 * time.Minute

// RenewalRecord is what came of asking for one account. It is kept in memory
// only: a renewal is not a thing to persist, and the account state in
// plugin-auth.json is the record that matters.
type RenewalRecord struct {
	Provider string `json:"provider"`
	Account  string `json:"account"`
	Renewed  bool   `json:"renewed"`
	Gone     bool   `json:"gone"`
	Err      string `json:"error,omitempty"`
	At       int64  `json:"at"`
	// Until is the new expiry, in epoch milliseconds, 0 when unknown.
	Until int64 `json:"until,omitempty"`
}

var (
	renewalMu   sync.Mutex
	recentRenew = map[string]RenewalRecord{}
)

// pluginProvidersFromAuth is the providers that have a signed-in account,
// read from plugin-auth.json alone.
//
// Renewal needs this rather than pluginhost.Providers: asking the plugins for
// their providers starts them and runs each loader, which renews the very
// sign-ins this is looking for.
func pluginProvidersFromAuth() []string {
	return pluginhost.ProvidersWithAccounts()
}

// expiryOf is an account sign-in expiry in epoch milliseconds, 0 unknown.
func expiryOf(provider, account string) int64 {
	a, ok := pluginhost.Auths(provider)[account]
	if !ok {
		return 0
	}
	if raw, ok := a["expires"].(float64); ok && raw > 0 {
		return int64(raw)
	}
	return 0
}

// signedInDue says whether an account sign-in ends within lead from now.
// known is false when the plugin keeps no expiry (an API key, or a sign-in
// its vendor does not date): such an account is never renewed.
func signedInDue(provider, account string, lead time.Duration) (due, known bool) {
	end := expiryOf(provider, account)
	if end == 0 {
		return false, false
	}
	return time.Until(time.UnixMilli(end)) <= lead, true
}

// RenewDue renews whatever sign-in of any provider comes due, and says what
// it did.
func RenewDue(ctx context.Context) []RenewalRecord {
	// The accounts due, read from plugin-auth.json before anything asks a
	// plugin anything. This has to come first: a plugin that renews inside
	// its loader renews as a side effect of being asked, and providers() and
	// every usage call ask it. Measured after that, nothing is ever due.
	type dueAccount struct {
		provider, account string
		before            int64
	}
	var dueList []dueAccount
	for _, provider := range pluginProvidersFromAuth() {
		for _, account := range pluginAccounts(provider) {
			if due, known := signedInDue(provider, account, renewLead); known && due {
				dueList = append(dueList, dueAccount{
					provider: provider, account: account,
					before: expiryOf(provider, account),
				})
			}
		}
	}
	if len(dueList) == 0 {
		return nil
	}
	var out []RenewalRecord
	{
		for _, d := range dueList {
			account := d.account
			before := d.before
			k, kerr := pluginhost.KeepSignedIn(ctx, d.provider, account)
			rec := RenewalRecord{Provider: d.provider, Account: account, At: time.Now().Unix()}
			if kerr != nil {
				rec.Err = kerr.Error()
			} else {
				rec.Renewed = k.Renewed
				rec.Gone = k.Gone
				rec.Err = k.Err
			}
			after := expiryOf(d.provider, account)
			if after > before {
				rec.Renewed = true
				rec.Until = after
			}
			if rec.Renewed || rec.Gone || rec.Err != "" {
				out = append(out, rec)
			}
		}
	}
	if len(out) > 0 {
		renewalMu.Lock()
		for _, r := range out {
			recentRenew[r.Provider+"|"+r.Account] = r
		}
		renewalMu.Unlock()
	}
	return out
}

// Renewals is what the last renewals came to, for a page to show.
func Renewals() []RenewalRecord {
	renewalMu.Lock()
	defer renewalMu.Unlock()
	out := make([]RenewalRecord, 0, len(recentRenew))
	for _, r := range recentRenew {
		out = append(out, r)
	}
	return out
}

// StartRenewWorker renews due sign-ins until ctx ends.
//
// Its first tick is earlier than the health sync first read, and each tick
// before that read again: the read renews as a side effect, so a renewal run
// after it would always find nothing to do.
func StartRenewWorker(ctx context.Context) {
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(15 * time.Second):
		}
		for {
			runRenewOnce(ctx)
			select {
			case <-ctx.Done():
				return
			case <-time.After(renewEvery):
			}
		}
	}()
}

func runRenewOnce(ctx context.Context) {
	if !pluginhost.ReadSettings().Enabled {
		return
	}
	if len(pluginhost.Load().Plugins) == 0 {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	for _, r := range RenewDue(cctx) {
		switch {
		case r.Renewed:
			common.SysLog("plugin renewal: " + r.Account + " renewed, until " +
				time.UnixMilli(r.Until).Format("2006-01-02 15:04"))
		case r.Gone:
			common.SysLog("plugin renewal: " + r.Account + " lapsed for good")
		case r.Err != "":
			common.SysLog("plugin renewal: " + r.Account + ": " + r.Err)
		}
	}
}
