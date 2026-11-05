package model

// What one plugin provider spent, read back by the channels it was
// registered as.
//
// The relay keeps two records of a request: the dashboard table
// (quota_data), which carries the tokens and the count and outlives a log
// cleanup, and the consume/error rows, which carry how long each request took
// and which ones failed. A provider's page needs both, so both are read here.

// ProviderUsageRow is one row of a provider's dashboard data, per hour and
// per model.
type ProviderUsageRow struct {
	CreatedAt        int64  `gorm:"column:created_at"`
	ChannelID        int    `gorm:"column:channel_id"`
	ModelName        string `gorm:"column:model_name"`
	Count            int    `gorm:"column:count"`
	Quota            int    `gorm:"column:quota"`
	TokenUsed        int    `gorm:"column:token_used"`
	PromptTokens     int    `gorm:"column:prompt_tokens"`
	CompletionTokens int    `gorm:"column:completion_tokens"`
}

// ProviderHourlyUsage is a provider's dashboard rows between two instants,
// grouped by hour, channel and model.
//
// It reads quota_data rather than the log rows because that is the table that
// outlives a log cleanup: a provider's spend should not fall to zero the day
// the logs are trimmed.
func ProviderHourlyUsage(channelIDs []int, start, end int64) ([]ProviderUsageRow, error) {
	if len(channelIDs) == 0 {
		return nil, nil
	}
	var rows []ProviderUsageRow
	err := DB.Table("quota_data").
		Select("created_at, channel_id, model_name, sum(count) as count, sum(quota) as quota, sum(token_used) as token_used, sum(prompt_tokens) as prompt_tokens, sum(completion_tokens) as completion_tokens").
		Where("channel_id IN ? and created_at >= ? and created_at <= ?", channelIDs, start, end).
		Group("created_at, channel_id, model_name").
		Find(&rows).Error
	return rows, err
}

// ProviderModelUsageRow is one model's share of a provider's spend.
type ProviderModelUsageRow struct {
	ModelName        string `gorm:"column:model_name"`
	Count            int    `gorm:"column:count"`
	Quota            int    `gorm:"column:quota"`
	TokenUsed        int    `gorm:"column:token_used"`
	PromptTokens     int    `gorm:"column:prompt_tokens"`
	CompletionTokens int    `gorm:"column:completion_tokens"`
}

// ProviderModelUsage is a provider's spend split by model.
func ProviderModelUsage(channelIDs []int, start, end int64) ([]ProviderModelUsageRow, error) {
	if len(channelIDs) == 0 {
		return nil, nil
	}
	var rows []ProviderModelUsageRow
	err := DB.Table("quota_data").
		Select("model_name, sum(count) as count, sum(quota) as quota, sum(token_used) as token_used, sum(prompt_tokens) as prompt_tokens, sum(completion_tokens) as completion_tokens").
		Where("channel_id IN ? and created_at >= ? and created_at <= ?", channelIDs, start, end).
		Group("model_name").
		Find(&rows).Error
	return rows, err
}

// ProviderModelSeconds is how long each of a provider's models took, summed
// over its requests. The dashboard table keeps no duration, so this reads
// the consume rows: a period whose logs were cleaned reports nothing rather
// than a wrong mean.
func ProviderModelSeconds(channelIDs []int, start, end int64) (map[string]int64, error) {
	out := map[string]int64{}
	if len(channelIDs) == 0 {
		return out, nil
	}
	var rows []struct {
		ModelName string `gorm:"column:model_name"`
		Seconds   int64  `gorm:"column:seconds"`
	}
	err := LOG_DB.Table("logs").
		Select("model_name, sum(use_time) as seconds").
		Where("channel_id IN ? and created_at >= ? and created_at <= ? and type = ?", channelIDs, start, end, LogTypeConsume).
		Group("model_name").
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		out[row.ModelName] = row.Seconds
	}
	return out, nil
}

// ProviderErrorCount is how many requests failed on each of a provider's
// channels. An error row names the channel it was tried on, so an account
// whose sign-in lapsed shows up here rather than only in its own row.
func ProviderErrorCount(channelIDs []int, start, end int64) (map[int]int, error) {
	out := map[int]int{}
	if len(channelIDs) == 0 {
		return out, nil
	}
	var rows []struct {
		ChannelID int `gorm:"column:channel_id"`
		Count     int `gorm:"column:count"`
	}
	err := LOG_DB.Table("logs").
		Select("channel_id, count(*) as count").
		Where("channel_id IN ? and created_at >= ? and created_at <= ? and type = ?", channelIDs, start, end, LogTypeError).
		Group("channel_id").
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		out[row.ChannelID] = row.Count
	}
	return out, nil
}

// ProviderRecentRequest is one request through a provider, as the live view
// plays it: which model was asked for, what answered, how long it took, and
// whether it failed.
type ProviderRecentRequest struct {
	Id               int    `json:"id" gorm:"column:id"`
	CreatedAt        int64  `json:"created_at" gorm:"column:created_at"`
	ModelName        string `json:"model_name" gorm:"column:model_name"`
	ChannelId        int    `json:"channel_id" gorm:"column:channel_id"`
	Username         string `json:"username" gorm:"column:username"`
	TokenName        string `json:"token_name" gorm:"column:token_name"`
	PromptTokens     int    `json:"prompt_tokens" gorm:"column:prompt_tokens"`
	CompletionTokens int    `json:"completion_tokens" gorm:"column:completion_tokens"`
	Quota            int    `json:"quota" gorm:"column:quota"`
	UseTime          int    `json:"use_time" gorm:"column:use_time"`
	IsStream         bool   `json:"is_stream" gorm:"column:is_stream"`
	// Type is LogTypeConsume for a request that answered, LogTypeError for
	// one that did not.
	Type int `json:"type" gorm:"column:type"`
	// Content is the error's own words, empty on a request that answered.
	Content string `json:"content,omitempty" gorm:"column:content"`
}

// ProviderRecent is the last limit requests through a provider's channels,
// newest first, answered or failed.
func ProviderRecent(channelIDs []int, limit int) ([]ProviderRecentRequest, error) {
	if len(channelIDs) == 0 {
		return nil, nil
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var rows []ProviderRecentRequest
	err := LOG_DB.Table("logs").
		Select("id, created_at, model_name, channel_id, username, token_name, prompt_tokens, completion_tokens, quota, use_time, is_stream, type, content").
		Where("channel_id IN ? and type IN ?", channelIDs, []int{LogTypeConsume, LogTypeError}).
		Order("created_at desc, id desc").
		Limit(limit).
		Find(&rows).Error
	return rows, err
}
