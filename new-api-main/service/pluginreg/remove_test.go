package pluginreg

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func poolOf(t *testing.T, keys []string) *model.Channel {
	t.Helper()
	ch := &model.Channel{
		Id:     900,
		Name:   "WorkBuddy",
		Key:    joinKeys(keys),
		Type:   constant.ChannelTypePluginProvider,
		Status: common.ChannelStatusEnabled,
		Models: "wb:glm-5.3",
		Group:  "default",
	}
	ch.ChannelInfo.IsMultiKey = true
	ch.ChannelInfo.MultiKeyMode = constant.MultiKeyModePolling
	ch.ChannelInfo.MultiKeySize = len(keys)
	ch.ChannelInfo.MultiKeyStatusList = map[int]int{0: common.ChannelStatusEnabled}
	if len(keys) > 1 {
		// the second account is resting: taking the first out must not wake it
		ch.ChannelInfo.MultiKeyStatusList[1] = common.ChannelStatusAutoDisabled
	}
	return ch
}

func joinKeys(keys []string) string {
	out := ""
	for i, k := range keys {
		if i > 0 {
			out += "\n"
		}
		out += k
	}
	return out
}

// Taking one account out of a pool leaves the others exactly as they were:
// a lapsed account stays resting, and the indices the status list is keyed by
// move with the keys they belong to.
func TestRemoveFromPoolKeepsTheOtherAccountsAndTheirStatus(t *testing.T) {
	ch := poolOf(t, []string{"workbuddy", "workbuddy#2apscn", "workbuddy#bx382e"})

	_, found := pruneAccount(ch, "workbuddy")
	require.True(t, found)

	assert.Equal(t, []string{"workbuddy#2apscn", "workbuddy#bx382e"}, ch.GetKeys())
	assert.True(t, ch.ChannelInfo.IsMultiKey)
	assert.Equal(t, 2, ch.ChannelInfo.MultiKeySize)
	// the resting account moved from index 1 to index 0, and is still resting
	assert.Equal(t, common.ChannelStatusAutoDisabled, ch.ChannelInfo.MultiKeyStatusList[0])
}

// A pool of one is not a pool: the row keeps the account in the field
// operators look in, and stops advertising a rotation it cannot do.
func TestRemovingDownToOneAccountLeavesAPlainChannel(t *testing.T) {
	ch := poolOf(t, []string{"workbuddy", "workbuddy#2apscn"})

	_, found := pruneAccount(ch, "workbuddy#2apscn")
	require.True(t, found)

	assert.Equal(t, "workbuddy", ch.Key)
	assert.False(t, ch.ChannelInfo.IsMultiKey)
	assert.Zero(t, ch.ChannelInfo.MultiKeySize)
	assert.Nil(t, ch.ChannelInfo.MultiKeyStatusList)
}

// An account that is not in the channel is not a reason to touch it: the
// caller may hold a channel by tag that never served this account.
func TestRemoveFromChannelIgnoresAnAccountItNeverHeld(t *testing.T) {
	ch := poolOf(t, []string{"workbuddy", "workbuddy#2apscn"})
	before := ch.Key

	kept, found := pruneAccount(ch, "workbuddy#nobody")
	assert.False(t, found)
	assert.Equal(t, before, ch.Key)
	assert.Equal(t, []string{"workbuddy", "workbuddy#2apscn"}, kept)
}
