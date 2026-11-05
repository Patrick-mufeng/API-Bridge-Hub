package pluginreg

import "testing"

// A namespaced model id answers to its bare form too: workbuddy-glm-5.3 → glm-5.3.
// The bare id is the group a client asks for without learning this hub's
// spelling.
func TestBareIDs(t *testing.T) {
	got := BareIDs([]string{"workbuddy-glm-5.3", "workbuddy-hy3", "plain", "workbuddy-glm-5.3"}, "workbuddy")
	want := []string{"glm-5.3", "hy3"}
	if len(got) != len(want) {
		t.Fatalf("BareIDs = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("BareIDs = %v, want %v", got, want)
		}
	}
}

// A model id with no namespace is its own bare id, so it is not listed
// again: publishing it would add a row identical to the one the channel
// already has.
func TestBareIDsSkipsUnnamespaced(t *testing.T) {
	// a model that does not carry this channel prefix has no bare form of
	// its own: publishing one would put a name nobody serves on the channel
	if got := BareIDs([]string{"cline-gpt-4o"}, "workbuddy"); len(got) != 0 {
		t.Errorf("BareIDs = %v, want none", got)
	}
	// and the one that does is stripped
	if got := BareIDs([]string{"workbuddy-gpt-4o"}, "workbuddy"); len(got) != 1 || got[0] != "gpt-4o" {
		t.Errorf("BareIDs = %v, want [gpt-4o]", got)
	}
}

// A model own id may carry a dash of its own: only the channel prefix is
// taken off, and the rest stays whole.
func TestBareIDsKeepsTheModelWhole(t *testing.T) {
	got := BareIDs([]string{"workbuddy-deepseek-v4.1-flash"}, "workbuddy")
	if len(got) != 1 || got[0] != "deepseek-v4.1-flash" {
		t.Errorf("BareIDs = %v, want [deepseek-v4.1-flash]", got)
	}
}

// Members that tie on priority are alternatives, not a sequence: the relay
// picks between them by weight, and at equal weight at random. Rank says
// which tier a member is in, so the console can draw "one of two" instead of
// an order that routing does not honour.
func TestBareMemberRankCountsDistinctPriorities(t *testing.T) {
	members := []BareMember{
		{ChannelID: 1, Priority: 100, Weight: 1},
		{ChannelID: 2, Priority: 100, Weight: 1},
		{ChannelID: 3, Priority: 0, Weight: 1},
		{ChannelID: 4, Priority: -5, Weight: 1},
	}
	// the sort BareRoutes does, applied here so the assertion is about ranks
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
	rank := -1
	last := int64(0)
	for i := range members {
		if i == 0 || members[i].Priority != last {
			rank++
			last = members[i].Priority
		}
		members[i].Rank = rank
	}

	// 100, 100, 0, -5 → three tiers: the two at 100 share the first
	if members[0].Rank != 0 || members[1].Rank != 0 {
		t.Errorf("the two at priority 100 must share rank 0, got %d and %d", members[0].Rank, members[1].Rank)
	}
	if members[2].Rank != 1 || members[3].Rank != 2 {
		t.Errorf("ranks = %d, %d, want 1 and 2", members[2].Rank, members[3].Rank)
	}
}
