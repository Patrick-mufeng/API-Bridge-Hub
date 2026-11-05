package pluginreg

import (
	"testing"
	"time"
)

// An account checked in today is left alone; the same result from an
// earlier day would skip a whole day of credits, so the day is part of it.
func TestAlreadyClaimedCountsTheDay(t *testing.T) {
	checkinMu.Lock()
	checkinLoaded = true
	checkinHistory = map[string]CheckinEntry{}
	checkinMu.Unlock()
	defer func() {
		checkinMu.Lock()
		checkinHistory = map[string]CheckinEntry{}
		checkinMu.Unlock()
	}()

	if alreadyClaimed("p", "p", "2026-11-04") {
		t.Fatal("an account never checked in reads as checked in")
	}
	set := func(outcome, day string) {
		checkinMu.Lock()
		checkinHistory["p|p"] = CheckinEntry{Outcome: outcome, Day: day}
		checkinMu.Unlock()
	}
	set("claimed", "2026-11-04")
	if !alreadyClaimed("p", "p", "2026-11-04") {
		t.Error("a claim today was not remembered")
	}
	if alreadyClaimed("p", "p", "2026-11-05") {
		t.Error("yesterday claim counts as today, so a day of credits is skipped")
	}
	// "done" is the vendor saying it was already claimed: the same day
	set("done", "2026-11-04")
	if !alreadyClaimed("p", "p", "2026-11-04") {
		t.Error("a done was not remembered")
	}
	// a failure is not a claim: the next run presses again
	set("failed", "2026-11-04")
	if alreadyClaimed("p", "p", "2026-11-04") {
		t.Error("a failure was taken as claimed")
	}
	set("ineligible", "2026-11-04")
	if alreadyClaimed("p", "p", "2026-11-04") {
		t.Error("an ineligible was taken as claimed")
	}
}

// The settings default to on: the check-in is the least interesting thing
// an operator does and the easiest to forget.
func TestCheckinDefaultsOn(t *testing.T) {
	checkinMu.Lock()
	checkinLoaded = true
	checkinSettings = CheckinSettings{Auto: true, At: 9, KeepDays: 7}
	checkinMu.Unlock()
	s := CheckinOptions()
	if !s.Auto {
		t.Error("the daily check-in is off by default")
	}
	if s.At != 9 {
		t.Errorf("the hour = %d, want 9", s.At)
	}
}

// Setting the hour refuses one that is not an hour of the day, rather than
// silently wrapping: a check-in at 25 is a check-in never.
func TestSetCheckinHourIsBounded(t *testing.T) {
	checkinMu.Lock()
	checkinLoaded = true
	checkinSettings = CheckinSettings{Auto: true, At: 9, KeepDays: 7}
	checkinMu.Unlock()
	bad := 25
	if s := SetCheckinOptions(nil, &bad); s.At != 9 {
		t.Errorf("hour 25 was accepted: %d", s.At)
	}
	good := 6
	if s := SetCheckinOptions(nil, &good); s.At != 6 {
		t.Errorf("hour 6 was refused: %d", s.At)
	}
	off := false
	if s := SetCheckinOptions(&off, nil); s.Auto {
		t.Error("turning it off did not")
	}
}

// A day is a day of the calendar, not an instant: two results on the same
// day belong together whatever time they were recorded.

var _ = time.Now
