package pluginreg

import (
	"context"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/pluginhost"
)

// healthEvery is how often the plugin accounts' health is read. A vendor's
// token lasts an hour or a day, and a hub that nobody opens should still
// route around an account that lapsed overnight; five minutes is often
// enough for that and cheap enough to leave running.
var healthEvery = 5 * time.Minute

// StartHealthWorker keeps every plugin account's channel in step with what
// its plugin says, until ctx ends.
//
// It does nothing while no plugin is installed, so a hub that never used
// one costs nothing. A failure is logged and tried again on the next tick:
// a plugin host that is down is not a reason to disable channels.
//
// Its first read is after the renewal worker first tick, not before it: this
// pass asks each account its allowance, and that ask renews a sign-in as a
// side effect (see renew.go). Reading first would spend the renewal before
// anything that counts renewals could see it.
func StartHealthWorker(ctx context.Context) {
	go func() {
		// the first read waits for the relay to be up: a start-up that
		// reads every account before serving anything is a slow start
		select {
		case <-ctx.Done():
			return
		case <-time.After(60 * time.Second):
		}
		for {
			runHealthOnce(ctx)
			select {
			case <-ctx.Done():
				return
			case <-time.After(healthEvery):
			}
		}
	}()
}

func runHealthOnce(ctx context.Context) {
	if !pluginhost.ReadSettings().Enabled {
		return
	}
	if len(pluginhost.Load().Plugins) == 0 {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	list, err := SyncHealth(cctx, "")
	if err != nil {
		common.SysLog("plugin account health: " + err.Error())
		return
	}
	if len(list) == 0 {
		return
	}
	changed := 0
	for _, h := range list {
		if h.Changed {
			changed++
		}
	}
	if changed > 0 {
		common.SysLog("plugin account health: " + DescribeHealth(list) + ", " + itoa(changed) + " channel(s) moved")
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
