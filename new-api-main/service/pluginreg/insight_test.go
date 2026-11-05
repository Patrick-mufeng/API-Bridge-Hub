package pluginreg

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// bucketStart is the first second of the bucket an instant falls in, so the
// trend's buckets line up with the operator's own days.
func TestBucketStartIsTheBucketFirstSecond(t *testing.T) {
	day := time.Date(2026, 11, 4, 13, 47, 12, 0, time.Local)
	start := bucketStart(day.Unix(), "day")
	back := time.Unix(start, 0)
	assert.Equal(t, 0, back.Hour())
	assert.Equal(t, 0, back.Minute())
	assert.Equal(t, 0, back.Second())
	assert.Equal(t, 4, back.Day())

	hour := bucketStart(day.Unix(), "hour")
	backHour := time.Unix(hour, 0)
	assert.Equal(t, 13, backHour.Hour())
	assert.Equal(t, 0, backHour.Minute())
	assert.LessOrEqual(t, hour, day.Unix())
	assert.Greater(t, day.Unix()-hour, int64(-1))
	assert.Less(t, day.Unix()-hour, int64(3600))
}

// A quiet hour is a zero in the line, not a gap in it: the trend covers
// every bucket of the period asked for.
func TestFillTrendCoversEveryBucket(t *testing.T) {
	start := time.Date(2026, 11, 1, 0, 0, 0, 0, time.Local).Unix()
	end := start + 4*86400 - 1

	trend := fillTrend(nil, start, end, "day")
	require.Len(t, trend, 4)
	for i, w := range trend {
		assert.Equal(t, start+int64(i)*86400, w.Start)
		assert.Zero(t, w.Requests)
	}

	found := map[int64]*UsageWindow{
		start + 2*86400: {Start: start + 2*86400, Requests: 3, Tokens: 120},
	}
	withData := fillTrend(found, start, end, "day")
	require.Len(t, withData, 4)
	assert.Equal(t, 0, withData[0].Requests)
	assert.Equal(t, 3, withData[2].Requests)
	assert.Equal(t, 120, withData[2].Tokens)
}

// An hour-wide period gets hour buckets, which is what an operator reads
// when looking at the last few hours.
func TestFillTrendHourly(t *testing.T) {
	start := time.Date(2026, 11, 4, 9, 0, 0, 0, time.Local).Unix()
	end := start + 3*3600 - 1

	trend := fillTrend(nil, start, end, "hour")
	require.Len(t, trend, 3)
	assert.Equal(t, start, trend[0].Start)
	assert.Equal(t, start+3600, trend[1].Start)
	assert.Equal(t, start+7200, trend[2].Start)
}

// A period must say both ends, and end after it starts.
func TestUsageRejectsABadPeriod(t *testing.T) {
	ctx := t.Context()
	now := time.Now().Unix()

	_, err := Usage(ctx, "", now-3600, now, "hour")
	require.Error(t, err)

	_, err = Usage(ctx, "workbuddy", 0, now, "hour")
	require.Error(t, err)

	_, err = Usage(ctx, "workbuddy", now, now-3600, "hour")
	require.Error(t, err)
}

// An account's label is its own name, or its key's end: what the console
// shows beside its allowance.
func TestAccountLabelFallsBackToTheKeyEnd(t *testing.T) {
	assert.Equal(t, "default account", shortAccount("workbuddy", "workbuddy"))
	assert.Equal(t, "2apscn", shortAccount("workbuddy", "workbuddy#2apscn"))
	assert.Equal(t, "bx382e", shortAccount("workbuddy", "workbuddy#bx382e"))
}
