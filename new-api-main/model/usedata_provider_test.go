package model

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A provider's spend is read back by the channels it was registered as:
// nothing else may reach the numbers, and the channels that were asked for
// are the only ones counted.
func TestProviderHourlyUsageCountsOnlyTheChannelsAskedFor(t *testing.T) {
	truncateTables(t)

	rows := []QuotaData{
		{ChannelID: 7, ModelName: "wb:glm-5.3", CreatedAt: 3600, Count: 2, Quota: 100, TokenUsed: 40, PromptTokens: 30, CompletionTokens: 10},
		{ChannelID: 7, ModelName: "wb:glm-5.3", CreatedAt: 3600, Count: 1, Quota: 50, TokenUsed: 20, PromptTokens: 15, CompletionTokens: 5},
		{ChannelID: 7, ModelName: "wb:hy3", CreatedAt: 7200, Count: 3, Quota: 60, TokenUsed: 12, PromptTokens: 8, CompletionTokens: 4},
		// another channel's spend must not be counted
		{ChannelID: 8, ModelName: "wb:glm-5.3", CreatedAt: 3600, Count: 9, Quota: 900, TokenUsed: 900},
	}
	for _, row := range rows {
		require.NoError(t, DB.Create(&row).Error)
	}

	found, err := ProviderHourlyUsage([]int{7}, 0, 10000)
	require.NoError(t, err)
	require.Len(t, found, 2)

	// the two rows of one hour and model are one bucket
	assert.Equal(t, int64(3600), found[0].CreatedAt)
	assert.Equal(t, 3, found[0].Count)
	assert.Equal(t, 150, found[0].Quota)
	assert.Equal(t, 60, found[0].TokenUsed)
	assert.Equal(t, 45, found[0].PromptTokens)
	assert.Equal(t, 15, found[0].CompletionTokens)

	assert.Equal(t, "wb:hy3", found[1].ModelName)
	assert.Equal(t, 3, found[1].Count)
}

// No channel means no query at all: a provider that was never registered
// has nothing to read, and must not fall back to every channel's numbers.
func TestProviderUsageWithNoChannelsReadsNothing(t *testing.T) {
	truncateTables(t)
	require.NoError(t, DB.Create(&QuotaData{ChannelID: 7, Count: 1, Quota: 1}).Error)

	found, err := ProviderHourlyUsage(nil, 0, 10000)
	require.NoError(t, err)
	assert.Empty(t, found)

	byModel, err := ProviderModelUsage(nil, 0, 10000)
	require.NoError(t, err)
	assert.Empty(t, byModel)

	recent, err := ProviderRecent(nil, 10)
	require.NoError(t, err)
	assert.Empty(t, recent)
}

// The model split is by model name, and the durations come from the consume
// rows, which are the only ones that carry one.
func TestProviderModelUsageAndSeconds(t *testing.T) {
	truncateTables(t)

	for _, row := range []QuotaData{
		{ChannelID: 7, ModelName: "wb:glm-5.3", CreatedAt: 3600, Count: 2, Quota: 100, TokenUsed: 40},
		{ChannelID: 7, ModelName: "wb:hy3", CreatedAt: 3600, Count: 1, Quota: 60, TokenUsed: 12},
	} {
		require.NoError(t, DB.Create(&row).Error)
	}
	for _, row := range []Log{
		{ChannelId: 7, ModelName: "wb:glm-5.3", Type: LogTypeConsume, UseTime: 4, CreatedAt: 3600},
		{ChannelId: 7, ModelName: "wb:glm-5.3", Type: LogTypeConsume, UseTime: 6, CreatedAt: 3700},
		{ChannelId: 7, ModelName: "wb:hy3", Type: LogTypeConsume, UseTime: 2, CreatedAt: 3800},
	} {
		require.NoError(t, LOG_DB.Create(&row).Error)
	}

	byModel, err := ProviderModelUsage([]int{7}, 0, 10000)
	require.NoError(t, err)
	require.Len(t, byModel, 2)

	seconds, err := ProviderModelSeconds([]int{7}, 0, 10000)
	require.NoError(t, err)
	assert.Equal(t, int64(10), seconds["wb:glm-5.3"])
	assert.Equal(t, int64(2), seconds["wb:hy3"])
}

// A failed request is counted where it was tried: an account whose sign-in
// lapsed shows up by its channel rather than only in its own row.
func TestProviderErrorCountReadsErrorRowsOnly(t *testing.T) {
	truncateTables(t)

	for _, row := range []Log{
		{ChannelId: 7, Type: LogTypeError, CreatedAt: 3600},
		{ChannelId: 7, Type: LogTypeError, CreatedAt: 3700},
		{ChannelId: 7, Type: LogTypeConsume, CreatedAt: 3800},
		{ChannelId: 8, Type: LogTypeError, CreatedAt: 3900},
	} {
		require.NoError(t, LOG_DB.Create(&row).Error)
	}

	failures, err := ProviderErrorCount([]int{7}, 0, 10000)
	require.NoError(t, err)
	assert.Equal(t, 2, failures[7])
	assert.Zero(t, failures[8])
}

// The live view reads both kinds of row, newest first, and says which is
// which: a request that answered carries its tokens, a failed one does not.
func TestProviderRecentReadsBothKindsNewestFirst(t *testing.T) {
	truncateTables(t)

	for _, row := range []Log{
		{ChannelId: 7, ModelName: "wb:glm-5.3", Type: LogTypeConsume, CreatedAt: 3600, PromptTokens: 20, CompletionTokens: 5, Quota: 30},
		{ChannelId: 7, ModelName: "wb:hy3", Type: LogTypeError, CreatedAt: 3800, Content: "the vendor said no"},
		// other log types are not requests
		{ChannelId: 7, Type: LogTypeTopup, CreatedAt: 3900},
	} {
		require.NoError(t, LOG_DB.Create(&row).Error)
	}

	recent, err := ProviderRecent([]int{7}, 10)
	require.NoError(t, err)
	require.Len(t, recent, 2)

	assert.Equal(t, LogTypeError, recent[0].Type)
	assert.Equal(t, "the vendor said no", recent[0].Content)
	assert.Equal(t, LogTypeConsume, recent[1].Type)
	assert.Equal(t, 20, recent[1].PromptTokens)
}
