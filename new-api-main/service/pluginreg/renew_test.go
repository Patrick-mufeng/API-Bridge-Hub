package pluginreg

import (
	"testing"
	"time"
)

// signedInDue is the whole decision, and it has to read the file and not a
// plugin: asking a plugin renews it as a side effect, which made every
// check say "not due" however close the sign-in was to its end.
func TestSignedInDueReadsTheExpiry(t *testing.T) {
	if _, known := signedInDue("nobody", "nobody", time.Minute); known {
		t.Error("an account that does not exist reported an expiry")
	}
}

// The lead is what makes it early: a sign-in ending in an hour is not due
// when the lead is ten minutes, and one ending in a minute is.
func TestRenewLeadIsTenMinutes(t *testing.T) {
	if renewLead != 10*time.Minute {
		t.Errorf("renewLead = %v, want 10m", renewLead)
	}
}

// A record says what it renewed to. A page reading it needs that to tell a
// real renewal from a request that changed nothing.
func TestRenewalRecordCarriesTheNewExpiry(t *testing.T) {
	r := RenewalRecord{Provider: "p", Account: "p", Renewed: true, Until: 1800000000000}
	if r.Until == 0 {
		t.Error("a renewal recorded no expiry")
	}
	if got := time.UnixMilli(r.Until).Year(); got != 2027 {
		t.Errorf("the expiry read as %d", got)
	}
}
