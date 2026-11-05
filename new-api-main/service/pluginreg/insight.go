package pluginreg

// A plugin provider's usage, read back from the relay's own records: the
// channels the provider was registered as, what each request through them
// cost, and how long it took.
//
// Nothing here is worked out again from the plugin. The plugin says what an
// account's allowance is (health.go reads that); the relay says what was
// spent against it. A provider's page shows the two side by side, which is
// what an operator reads when deciding which account a request should reach.

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/pluginhost"
)

// UsageWindow is one bucket of a provider's spend: an hour or a day of
// requests, whichever the caller asked for.
type UsageWindow struct {
	// Start is the bucket's first second, Unix seconds.
	Start            int64 `json:"start"`
	Requests         int   `json:"requests"`
	PromptTokens     int   `json:"prompt_tokens"`
	CompletionTokens int   `json:"completion_tokens"`
	Tokens           int   `json:"tokens"`
	Quota            int   `json:"quota"`
}

// UsageModel is what one model of a provider cost in the period asked for.
type UsageModel struct {
	Model string `json:"model"`
	// Bare is the id a client asks for when it does not name the namespace
	// (glm-5.3 for wb:glm-5.3), empty when there is no prefix to strip.
	Bare             string `json:"bare,omitempty"`
	Requests         int    `json:"requests"`
	PromptTokens     int    `json:"prompt_tokens"`
	CompletionTokens int    `json:"completion_tokens"`
	Tokens           int    `json:"tokens"`
	Quota            int    `json:"quota"`
	// Seconds is the sum of the requests' own durations, so Average is their
	// mean and not a wall clock's.
	Seconds int64   `json:"seconds"`
	Average float64 `json:"average"`
}

// UsageAccount is one account of a provider and its share of the spend.
//
// An account is a channel when the provider was registered one per account.
// When the accounts are pooled into one channel, the relay cannot say which
// of its keys answered, so Channel stays 0 and the page shows the pool's
// spend under the channel rather than inventing a split.
type UsageAccount struct {
	Account  string `json:"account"`
	Label    string `json:"label,omitempty"`
	Channel  int    `json:"channel_id"`
	Requests int    `json:"requests"`
	Tokens   int    `json:"tokens"`
	Quota    int    `json:"quota"`
	// On is whether the channel this account is served from is enabled now.
	On bool `json:"on"`
}

// UsageChannel is one channel of a provider: the row in the relay's channel
// list that a request through this provider lands on.
type UsageChannel struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Tag    string `json:"tag,omitempty"`
	Prefix string `json:"prefix,omitempty"`
	// Models is how many relay model names the channel serves.
	Models   int   `json:"models"`
	Enabled  bool  `json:"enabled"`
	Priority int64 `json:"priority"`
	Weight   uint  `json:"weight"`
	// Keys is how many accounts the channel pools, 0 for a plain one.
	Keys int `json:"keys"`
	// Requests, Tokens and Quota are this channel's share of the spend.
	Requests int `json:"requests"`
	Tokens   int `json:"tokens"`
	Quota    int `json:"quota"`
}

// UsageSummary is a provider's usage over one period: the totals, the trend
// that drew them, and the three ways of splitting them an operator looks at
// -- by model, by account, by channel.
type UsageSummary struct {
	Provider string `json:"provider"`
	Name     string `json:"name"`
	// Start and End are the period's bounds in Unix seconds, as asked for.
	Start int64 `json:"start"`
	End   int64 `json:"end"`
	// Granularity is "hour" or "day": the width of one Trend bucket.
	Granularity string `json:"granularity"`

	Requests         int `json:"requests"`
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	Tokens           int `json:"tokens"`
	Quota            int `json:"quota"`
	// Errors are the requests through this provider's channels that failed.
	Errors int `json:"errors"`

	// Seconds is the sum of the answered requests' durations.
	Seconds int64   `json:"seconds"`
	Average float64 `json:"average"`

	Trend    []UsageWindow  `json:"trend"`
	Models   []UsageModel   `json:"models"`
	Accounts []UsageAccount `json:"accounts"`
	Channels []UsageChannel `json:"channels"`
	// Serving is how many of those channels are enabled now.
	Serving int `json:"serving"`
}

// Usage reads one provider's usage between two instants. granularity is
// "hour" or "day"; anything else is taken as day.
//
// The numbers are keyed by the channels this provider is registered as: a
// request that went through the provider's channel is its spend, whatever
// account answered it.
func Usage(ctx context.Context, provider string, start, end int64, granularity string) (*UsageSummary, error) {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return nil, fmt.Errorf("no provider named")
	}
	if start <= 0 || end <= 0 {
		return nil, fmt.Errorf("the period needs a start and an end")
	}
	if end < start {
		return nil, fmt.Errorf("the period ends before it starts")
	}
	if granularity != "hour" {
		granularity = "day"
	}

	// the channels this provider is registered as: the rows a request
	// through it lands on, and the key the spend is read back by
	channels := make([]UsageChannel, 0, 4)
	for _, ch := range providerChannels(provider) {
		channels = append(channels, UsageChannel{
			ID: ch.ID, Name: ch.Name, Tag: ch.Tag, Prefix: ch.Prefix,
			Models: ch.Models, Enabled: ch.Enabled,
			Priority: ch.Priority, Weight: ch.Weight, Keys: ch.Keys,
		})
	}
	summary := &UsageSummary{
		Provider: provider, Start: start, End: end, Granularity: granularity,
	}
	byID := make(map[int]int, len(channels))
	ids := make([]int, 0, len(channels))
	for i := range channels {
		byID[channels[i].ID] = i
		ids = append(ids, channels[i].ID)
		if channels[i].Enabled {
			summary.Serving++
		}
	}
	if ps, err := pluginhost.Providers(ctx); err == nil {
		for i := range ps {
			if ps[i].ID == provider {
				summary.Name = ps[i].Name
				break
			}
		}
	}
	if summary.Name == "" {
		summary.Name = provider
	}

	hourly, err := model.ProviderHourlyUsage(ids, start, end)
	if err != nil {
		return nil, err
	}
	buckets := map[int64]*UsageWindow{}
	for _, row := range hourly {
		at := bucketStart(row.CreatedAt, granularity)
		w := buckets[at]
		if w == nil {
			w = &UsageWindow{Start: at}
			buckets[at] = w
		}
		w.Requests += row.Count
		w.PromptTokens += row.PromptTokens
		w.CompletionTokens += row.CompletionTokens
		w.Tokens += row.TokenUsed
		w.Quota += row.Quota

		summary.Requests += row.Count
		summary.PromptTokens += row.PromptTokens
		summary.CompletionTokens += row.CompletionTokens
		summary.Tokens += row.TokenUsed
		summary.Quota += row.Quota
		if i, ok := byID[row.ChannelID]; ok {
			channels[i].Requests += row.Count
			channels[i].Tokens += row.TokenUsed
			channels[i].Quota += row.Quota
		}
	}

	// per model: the spend from the dashboard table, the durations from the
	// consume rows, which are the only ones that carry a duration
	rows, err := model.ProviderModelUsage(ids, start, end)
	if err != nil {
		return nil, err
	}
	seconds, err := model.ProviderModelSeconds(ids, start, end)
	if err != nil {
		return nil, err
	}
	// the prefix the models were namespaced with, so a model row can say the
	// bare id a client asks for as well
	prefix := ""
	for i := range channels {
		if channels[i].Prefix != "" {
			prefix = channels[i].Prefix
			break
		}
	}
	for _, row := range rows {
		m := UsageModel{
			Model: row.ModelName, Requests: row.Count,
			PromptTokens: row.PromptTokens, CompletionTokens: row.CompletionTokens,
			Tokens: row.TokenUsed, Quota: row.Quota,
			Seconds: seconds[row.ModelName],
		}
		if m.Requests > 0 {
			m.Average = float64(m.Seconds) / float64(m.Requests)
		}
		summary.Seconds += m.Seconds
		if prefix != "" {
			if bare, ok := modelOfPrefix(m.Model, prefix); ok {
				m.Bare = bare
			}
		}
		summary.Models = append(summary.Models, m)
	}
	if summary.Requests > 0 {
		summary.Average = float64(summary.Seconds) / float64(summary.Requests)
	}
	sort.SliceStable(summary.Models, func(i, j int) bool {
		if summary.Models[i].Tokens != summary.Models[j].Tokens {
			return summary.Models[i].Tokens > summary.Models[j].Tokens
		}
		return summary.Models[i].Model < summary.Models[j].Model
	})

	failures, err := model.ProviderErrorCount(ids, start, end)
	if err != nil {
		return nil, err
	}
	for _, n := range failures {
		summary.Errors += n
	}

	summary.Channels = channels
	summary.Trend = fillTrend(buckets, start, end, granularity)
	summary.Accounts = accountUsage(provider, channels)
	return summary, nil
}

// accountUsage lists a provider's accounts with the share of the spend each
// one's own channel carries. A pooled account has no channel of its own, so
// its figures stay zero and the pool's spend is read from Channels instead.
func accountUsage(provider string, channels []UsageChannel) []UsageAccount {
	byAccount := map[string]*UsageChannel{}
	for i := range channels {
		key, ok := strings.CutPrefix(channels[i].Tag, TagPrefix+provider+":")
		if !ok || key == "" {
			continue
		}
		byAccount[key] = &channels[i]
	}
	auths := pluginhost.Auths(provider)
	out := make([]UsageAccount, 0, len(auths))
	for key := range auths {
		a := UsageAccount{Account: key, Label: shortAccount(provider, key)}
		if ch := byAccount[key]; ch != nil {
			a.Channel = ch.ID
			a.Requests = ch.Requests
			a.Tokens = ch.Tokens
			a.Quota = ch.Quota
			a.On = ch.Enabled
		}
		out = append(out, a)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Tokens != out[j].Tokens {
			return out[i].Tokens > out[j].Tokens
		}
		return out[i].Account < out[j].Account
	})
	return out
}

// bucketStart is the first second of the bucket an instant falls in, in the
// server's own zone: an operator's "today" is the day they are in.
func bucketStart(ts int64, granularity string) int64 {
	if granularity == "hour" {
		return ts - (ts % 3600)
	}
	t := time.Unix(ts, 0)
	year, month, day := t.Date()
	return time.Date(year, month, day, 0, 0, 0, 0, t.Location()).Unix()
}

// fillTrend lays what was read back over every bucket of the period, so a
// quiet hour is a zero in the line rather than a gap in it.
func fillTrend(found map[int64]*UsageWindow, start, end int64, granularity string) []UsageWindow {
	step := int64(86400)
	if granularity == "hour" {
		step = 3600
	}
	out := make([]UsageWindow, 0, (end-start)/step+1)
	for at := bucketStart(start, granularity); at <= end; at += step {
		if w := found[at]; w != nil {
			out = append(out, *w)
			continue
		}
		out = append(out, UsageWindow{Start: at})
	}
	return out
}

// RecentRequests is the last limit requests through a provider's channels,
// newest first: what a page plays as it happens.
func RecentRequests(provider string, limit int) ([]model.ProviderRecentRequest, error) {
	channels := providerChannels(provider)
	ids := make([]int, 0, len(channels))
	for i := range channels {
		ids = append(ids, channels[i].ID)
	}
	return model.ProviderRecent(ids, limit)
}
