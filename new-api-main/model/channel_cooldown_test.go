package model

import (
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// pooledChannel is a channel of three accounts, all enabled, ready to poll.
func pooledChannel(t *testing.T, keys ...string) *Channel {
	t.Helper()
	setupChannelStatusTest(t)
	channel := Channel{
		Name:   "pooled",
		Key:    joinKeys(keys),
		Status: common.ChannelStatusEnabled,
		ChannelInfo: ChannelInfo{
			IsMultiKey:   true,
			MultiKeySize: len(keys),
			MultiKeyMode: constant.MultiKeyModePolling,
		},
	}
	require.NoError(t, DB.Create(&channel).Error)
	require.NoError(t, channel.SaveChannelInfo())
	return &channel
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

// A resting key is skipped, not disabled: the rest of the pool keeps serving,
// and the channel as a whole stays enabled.
func TestRestMultiKeySkipsAKeyWithoutDisablingTheChannel(t *testing.T) {
	channel := pooledChannel(t, "key-a", "key-b", "key-c")

	require.True(t, channel.RestMultiKey("key-b", time.Minute, "429 from upstream"))
	require.NoError(t, channel.SaveChannelInfo())

	stored, err := GetChannelById(channel.Id, true)
	require.NoError(t, err)
	assert.Equal(t, common.ChannelStatusEnabled, stored.Status,
		"one account throttled must not take the pool down")
	assert.Empty(t, stored.ChannelInfo.MultiKeyStatusList,
		"resting is not disabling: the key's status is untouched")
	assert.Greater(t, stored.ChannelInfo.MultiKeyCooldownUntil[1], common.GetTimestamp())

	// polling walks past it
	for i := 0; i < 6; i++ {
		key, idx, apiErr := stored.GetNextEnabledKey()
		require.Nil(t, apiErr)
		assert.NotEqual(t, 1, idx, "a resting key was polled")
		assert.NotEqual(t, "key-b", key)
	}
}

// A rest runs out on its own: nothing has to turn the key back on.
func TestRestMultiKeyExpires(t *testing.T) {
	channel := pooledChannel(t, "key-a", "key-b")

	require.True(t, channel.RestMultiKey("key-b", time.Minute, "429"))
	channel.ChannelInfo.MultiKeyCooldownUntil[1] = common.GetTimestamp() - 1 // one second ago
	require.NoError(t, channel.SaveChannelInfo())

	stored, err := GetChannelById(channel.Id, true)
	require.NoError(t, err)
	// polling alternates between two keys, so both must come up
	seen := map[string]bool{}
	for i := 0; i < 4; i++ {
		key, _, apiErr := stored.GetNextEnabledKey()
		require.Nil(t, apiErr)
		seen[key] = true
	}
	assert.True(t, seen["key-b"], "an expired rest is no rest")
	assert.True(t, seen["key-a"])
}

// A key that answers is not resting any more, whatever an earlier 429 said.
func TestClearMultiKeyRest(t *testing.T) {
	channel := pooledChannel(t, "key-a", "key-b")

	require.True(t, channel.RestMultiKey("key-a", time.Minute, "429"))
	require.NoError(t, channel.SaveChannelInfo())
	require.True(t, channel.ClearMultiKeyRest("key-a"))
	require.NoError(t, channel.SaveChannelInfo())

	stored, err := GetChannelById(channel.Id, true)
	require.NoError(t, err)
	_, ok := stored.ChannelInfo.MultiKeyCooldownUntil[0]
	assert.False(t, ok, "the rest should be gone")
	assert.False(t, channel.ClearMultiKeyRest("key-a"), "clearing twice is a no-op")
}

// Every key resting is still better than "no available keys": the client gets
// an answer instead of a pool that looks empty.
func TestGetNextEnabledKeyWithEveryKeyRestingPicksTheSoonest(t *testing.T) {
	channel := pooledChannel(t, "key-a", "key-b")
	require.True(t, channel.RestMultiKey("key-a", time.Minute, "429"))
	require.True(t, channel.RestMultiKey("key-b", 10*time.Second, "429"))
	require.NoError(t, channel.SaveChannelInfo())

	stored, err := GetChannelById(channel.Id, true)
	require.NoError(t, err)
	key, idx, apiErr := stored.GetNextEnabledKey()
	require.Nil(t, apiErr, "a fully resting pool still serves")
	assert.Equal(t, "key-b", key, "the one coming back soonest is tried first")
	assert.Equal(t, 1, idx)
}

// A disabled key stays disabled: the manual switch is stronger than a rest.
func TestRestMultiKeyLeavesADisabledKeyAlone(t *testing.T) {
	channel := pooledChannel(t, "key-a", "key-b")
	channel.ChannelInfo.MultiKeyStatusList = map[int]int{0: common.ChannelStatusManuallyDisabled}
	require.NoError(t, channel.SaveChannelInfo())

	assert.False(t, channel.RestMultiKey("key-a", time.Minute, "429"),
		"resting must not resurrect a key someone switched off")
}

// The split that makes resting safe: a throttle passes, a revoked sign-in does
// not.
func TestCooldownForStatus(t *testing.T) {
	assert.Equal(t, time.Minute, CooldownForStatus(429))
	assert.Equal(t, 30*time.Second, CooldownForStatus(500))
	assert.Equal(t, 30*time.Second, CooldownForStatus(503))
	assert.Zero(t, CooldownForStatus(401), "a revoked token needs a sign-in, not a rest")
	assert.Zero(t, CooldownForStatus(403))
	assert.Zero(t, CooldownForStatus(400))
	assert.Zero(t, CooldownForStatus(200))
}

// An account near the end of its allowance is not handed a request while
// another account has room: that turn would come back as a 429.
func TestGetNextEnabledKeySkipsAnAccountNearlySpent(t *testing.T) {
	channel := pooledChannel(t, "key-a", "key-b")
	channel.ChannelInfo.MultiKeyUsedShare = map[int]float64{0: 96}
	channel.ChannelInfo.MultiKeyUsageAt = map[int]int64{0: common.GetTimestamp()}
	require.NoError(t, channel.SaveChannelInfo())

	stored, err := GetChannelById(channel.Id, true)
	require.NoError(t, err)
	for i := 0; i < 4; i++ {
		key, idx, apiErr := stored.GetNextEnabledKey()
		require.Nil(t, apiErr)
		assert.Equal(t, "key-b", key, "the nearly-spent account got the request")
		assert.Equal(t, 1, idx)
	}
}

// A stale figure is no figure: the window it described has probably reset.
func TestGetNextEnabledKeyIgnoresAStaleShare(t *testing.T) {
	channel := pooledChannel(t, "key-a", "key-b")
	channel.ChannelInfo.MultiKeyUsedShare = map[int]float64{0: 99}
	channel.ChannelInfo.MultiKeyUsageAt = map[int]int64{0: common.GetTimestamp() - 3600}
	require.NoError(t, channel.SaveChannelInfo())

	stored, err := GetChannelById(channel.Id, true)
	require.NoError(t, err)
	seen := map[string]bool{}
	for i := 0; i < 4; i++ {
		key, _, apiErr := stored.GetNextEnabledKey()
		require.Nil(t, apiErr)
		seen[key] = true
	}
	assert.True(t, seen["key-a"], "a reading an hour old must not steer routing")
}

// Every account nearly spent: the pool still serves rather than reporting
// itself empty.
func TestGetNextEnabledKeyWithEveryAccountSpentStillServes(t *testing.T) {
	channel := pooledChannel(t, "key-a", "key-b")
	channel.ChannelInfo.MultiKeyUsedShare = map[int]float64{0: 99, 1: 98}
	channel.ChannelInfo.MultiKeyUsageAt = map[int]int64{0: common.GetTimestamp(), 1: common.GetTimestamp()}
	require.NoError(t, channel.SaveChannelInfo())

	stored, err := GetChannelById(channel.Id, true)
	require.NoError(t, err)
	key, _, apiErr := stored.GetNextEnabledKey()
	require.Nil(t, apiErr)
	assert.Contains(t, []string{"key-a", "key-b"}, key)
}
