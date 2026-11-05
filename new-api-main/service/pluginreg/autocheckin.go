package pluginreg

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/pluginhost"
)

// Daily check-in, done by itself.
//
// Many subscriptions hand out credits once a day for pressing a button. The
// operator chose to have that pressed automatically: an account nobody
// checked in leaves credits unclaimed, and nobody wants to open a page at
// midnight to claim them.
//
// What has been checked in is remembered by the vendor day, not ours: a
// vendor whose day turns at 10:00 UTC+8 has not handed out the new credits
// at Beijing midnight, and pressing then claims the previous one.

// CheckinSettings is whether the daily check-in runs by itself.
type CheckinSettings struct {
	// Auto is the operator switch, on unless turned off.
	Auto bool `json:"auto"`
	// At is the hour of the local day it runs at, 0-23.
	At int `json:"at"`
	// KeepDays is how many days of results are remembered.
	KeepDays int `json:"keep_days"`
	// LastRun is when it last ran, in Unix seconds.
	LastRun int64 `json:"last_run,omitempty"`
	// LastSaid is one line of what it came to.
	LastSaid string `json:"last_said,omitempty"`
}

var (
	checkinMu       sync.Mutex
	checkinSettings = CheckinSettings{Auto: true, At: 9, KeepDays: 7}
	checkinHistory  = map[string]CheckinEntry{}
	checkinLoaded   bool
)

// checkinFile is where the setting and the days results are kept.
func checkinFile() string {
	return filepath.Join(filepath.Dir(pluginhost.AuthPath()), "plugin-checkin.json")
}

type checkinState struct {
	Settings CheckinSettings         `json:"settings"`
	History  map[string]CheckinEntry `json:"history"`
}

func loadCheckin() {
	if checkinLoaded {
		return
	}
	checkinLoaded = true
	b, err := os.ReadFile(checkinFile())
	if err != nil {
		return
	}
	var st checkinState
	if json.Unmarshal(b, &st) != nil {
		return
	}
	// the switch defaults on, so a file written before it existed keeps it on
	if st.Settings.KeepDays == 0 {
		st.Settings.KeepDays = 7
	}
	checkinSettings = st.Settings
	if st.History != nil {
		checkinHistory = st.History
	}
}

func saveCheckin() {
	checkinMu.Lock()
	b, err := json.MarshalIndent(checkinState{
		Settings: checkinSettings,
		History:  checkinHistory,
	}, "", "  ")
	if err == nil {
		if err := os.MkdirAll(filepath.Dir(checkinFile()), 0o755); err == nil {
			_ = os.WriteFile(checkinFile(), b, 0o600)
		}
	}
	checkinMu.Unlock()
}

// CheckinOptions is the daily check-in settings, for a page to read.
func CheckinOptions() CheckinSettings {
	checkinMu.Lock()
	defer checkinMu.Unlock()
	loadCheckin()
	return checkinSettings
}

// SetCheckinOptions changes them. A nil leaves that setting as it is.
func SetCheckinOptions(auto *bool, at *int) CheckinSettings {
	checkinMu.Lock()
	loadCheckin()
	if auto != nil {
		checkinSettings.Auto = *auto
	}
	if at != nil && *at >= 0 && *at <= 23 {
		checkinSettings.At = *at
	}
	s := checkinSettings
	checkinMu.Unlock()
	saveCheckin()
	return s
}

// CheckinHistory is what each account last check-in came to.
func CheckinHistory() map[string]CheckinEntry {
	checkinMu.Lock()
	defer checkinMu.Unlock()
	loadCheckin()
	out := make(map[string]CheckinEntry, len(checkinHistory))
	for k, v := range checkinHistory {
		out[k] = v
	}
	return out
}

// alreadyClaimed is whether this account was checked in for today.
//
// A "done" from an earlier day does not count: the vendor hands out a new
// one when its day turns, and leaving it out would skip a whole day.
func alreadyClaimed(provider, account, today string) bool {
	checkinMu.Lock()
	defer checkinMu.Unlock()
	loadCheckin()
	prev, ok := checkinHistory[provider+"|"+account]
	if !ok {
		return false
	}
	if prev.Outcome != "claimed" && prev.Outcome != "done" {
		return false
	}
	return prev.Day == today
}

// RunAutoCheckin presses the daily check-in for every account that has not
// been pressed today. A vendor answer of "already checked in" is recorded
// as done, so the next run leaves it alone.
func RunAutoCheckin(ctx context.Context) *CheckinResult {
	ps, err := pluginhost.Providers(ctx)
	if err != nil {
		common.SysLog("plugin check-in: " + err.Error())
		return nil
	}
	now := time.Now()
	today := now.Format("2006-01-02")
	total := &CheckinResult{}
	for _, p := range ps {
		if !p.Checkin {
			continue
		}
		for _, account := range pluginAccounts(p.ID) {
			if alreadyClaimed(p.ID, account, today) {
				continue
			}
			r, cerr := Checkin(ctx, p.ID, account)
			if cerr != nil {
				continue
			}
			for _, e := range r.Accounts {
				e.Day = today
				checkinMu.Lock()
				loadCheckin()
				checkinHistory[p.ID+"|"+e.Account] = e
				checkinMu.Unlock()
				total.Accounts = append(total.Accounts, e)
				if e.Outcome == "claimed" || e.Outcome == "done" {
					total.Claimed++
				} else {
					total.Failed++
				}
			}
		}
	}
	checkinMu.Lock()
	checkinSettings.LastRun = now.Unix()
	if total.Claimed > 0 || total.Failed > 0 {
		checkinSettings.LastSaid = itoa(total.Claimed) + " claimed, " + itoa(total.Failed) + " not"
	}
	cutoff := now.AddDate(0, 0, -checkinSettings.KeepDays).Format("2006-01-02")
	for k, v := range checkinHistory {
		if v.Day != "" && v.Day < cutoff {
			delete(checkinHistory, k)
		}
	}
	checkinMu.Unlock()
	saveCheckin()
	return total
}

// StartCheckinWorker presses the daily check-in at the hour chosen, until
// ctx ends.
func StartCheckinWorker(ctx context.Context) {
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(90 * time.Second):
		}
		for {
			if s := CheckinOptions(); s.Auto && time.Now().Hour() >= s.At {
				cctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
				RunAutoCheckin(cctx)
				cancel()
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(30 * time.Minute):
			}
		}
	}()
}
