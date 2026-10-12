package reverse_proxy

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
)

const modelsFetchTimeout = 15 * time.Second

// expandHome resolves a leading "~" (with "~/" or "~\" or bare "~") to the
// user's home directory, so manifests can point at service-owned state that
// lives outside the hub, such as ~/.opencodez-free/agent-key.txt. The service
// mints that file itself, so a packager must not pre-create it.
func expandHome(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed != "~" && !strings.HasPrefix(trimmed, "~/") && !strings.HasPrefix(trimmed, `~\`) {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return path
	}
	if trimmed == "~" {
		return home
	}
	return filepath.Join(home, trimmed[2:])
}

// ReadKey extracts the service's client API key according to key_source.
func (s *Service) ReadKey() (string, error) {
	source := s.Manifest.KeySource
	if source == nil {
		return "", fmt.Errorf("manifest has no key_source")
	}
	path := expandHome(source.Path)
	if !filepath.IsAbs(path) {
		path = filepath.Join(s.Workdir, path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read key file: %w", err)
	}
	content := strings.TrimPrefix(string(data), "\ufeff")
	switch source.Type {
	case "json":
		var fields map[string]any
		if err := common.Unmarshal([]byte(content), &fields); err != nil {
			return "", fmt.Errorf("parse key file JSON: %w", err)
		}
		value, _ := fields[source.Field].(string)
		value = strings.TrimSpace(value)
		if value == "" {
			return "", fmt.Errorf("field %q is empty in %s", source.Field, path)
		}
		return value, nil
	case "env":
		value, ok := envValue(content, source.Field)
		if !ok {
			return "", fmt.Errorf("variable %q not found in %s", source.Field, path)
		}
		return pickKey(value, source.Index)
	default: // text
		return pickKey(strings.TrimSpace(content), source.Index)
	}
}

// envValue finds KEY=value in a dotenv-style file.
func envValue(content, key string) (string, bool) {
	for line := range strings.SplitSeq(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		name, value, found := strings.Cut(line, "=")
		if !found || strings.TrimSpace(name) != key {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
				value = value[1 : len(value)-1]
			}
		}
		return strings.TrimSpace(value), true
	}
	return "", false
}

// pickKey selects one item from a comma-separated key list.
func pickKey(value string, index int) (string, error) {
	parts := strings.Split(value, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	if index < 0 || index >= len(parts) || parts[index] == "" {
		if len(parts) == 1 && parts[0] != "" {
			return parts[0], nil
		}
		return "", fmt.Errorf("key list has %d value(s); index %d is unavailable", len(parts), index)
	}
	return parts[index], nil
}

// MaskKey hides all but a short prefix/suffix of a secret.
func MaskKey(key string) string {
	if key == "" {
		return ""
	}
	if len(key) <= 10 {
		return strings.Repeat("*", len(key))
	}
	return key[:4] + strings.Repeat("*", 6) + key[len(key)-4:]
}

// FetchModels asks the service for its OpenAI-compatible model list.
func FetchModels(baseURL, key string) ([]string, error) {
	request, err := http.NewRequest(http.MethodGet, baseURL+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	if key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	client := &http.Client{Timeout: modelsFetchTimeout}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET /v1/models returned HTTP %d: %s", response.StatusCode, truncateForError(string(body)))
	}
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := common.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("parse /v1/models response: %w", err)
	}
	models := make([]string, 0, len(payload.Data))
	seen := map[string]bool{}
	for _, item := range payload.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, id)
	}
	if len(models) == 0 {
		return nil, fmt.Errorf("service returned an empty model list; open the service panel and sign in an account first")
	}
	return models, nil
}

func truncateForError(text string) string {
	text = strings.TrimSpace(text)
	if len(text) > 200 {
		return text[:200] + "..."
	}
	return text
}

// ChannelViewOf summarizes the relay channel currently bound to a service.
func (m *Manager) ChannelViewOf(svc *Service) ChannelView {
	channels, err := model.GetChannelsByTag(svc.ChannelTag(), true, true)
	if err != nil || len(channels) == 0 {
		return ChannelView{Registered: false}
	}
	channel := channels[0]
	view := ChannelView{
		Registered: true,
		ID:         channel.Id,
		Name:       channel.Name,
		Status:     channel.Status,
	}
	if models := channel.GetModels(); len(models) > 0 {
		view.Models = len(models)
	}
	return view
}

// RegisterChannel creates or updates the relay channel that points at this
// service, then refreshes the channel cache.
func (m *Manager) RegisterChannel(svc *Service) (*ChannelView, []string, error) {
	if svc.Manifest.Channel == nil {
		return nil, nil, fmt.Errorf("service %q has no channel section in its manifest", svc.Manifest.ID)
	}
	key, err := svc.ReadKey()
	if err != nil {
		return nil, nil, err
	}
	upstreamModels, err := FetchModels(svc.BaseURL(), key)
	if err != nil {
		return nil, nil, fmt.Errorf("fetch models from %s: %w", svc.BaseURL(), err)
	}
	models, modelMapping := svc.NamespacedModels(upstreamModels)
	name := svc.ChannelName()
	group := svc.ChannelGroup()
	tag := svc.ChannelTag()
	baseURL := svc.BaseURL()
	modelList := strings.Join(models, ",")
	mappingJSON := ""
	if len(modelMapping) > 0 {
		encoded, err := common.Marshal(modelMapping)
		if err != nil {
			return nil, nil, fmt.Errorf("encode model mapping: %w", err)
		}
		mappingJSON = string(encoded)
	}
	var mappingPtr *string
	if mappingJSON != "" {
		mappingPtr = &mappingJSON
	}

	existing, err := model.GetChannelsByTag(tag, true, true)
	if err != nil {
		return nil, nil, fmt.Errorf("look up channel by tag: %w", err)
	}
	view := &ChannelView{Registered: true, Name: name, Status: common.ChannelStatusEnabled, Models: len(models)}
	if len(existing) > 0 {
		channel := existing[0]
		channel.Name = name
		channel.Key = key
		channel.BaseURL = &baseURL
		channel.Models = modelList
		channel.Group = group
		channel.Status = common.ChannelStatusEnabled
		channel.Tag = &tag
		channel.ModelMapping = mappingPtr
		if svc.Manifest.Channel.Priority != nil {
			channel.Priority = svc.Manifest.Channel.Priority
		}
		if svc.Manifest.Channel.Weight != nil {
			channel.Weight = svc.Manifest.Channel.Weight
		}
		if err := channel.Update(); err != nil {
			return nil, nil, fmt.Errorf("update channel %d: %w", channel.Id, err)
		}
		view.ID = channel.Id
	} else {
		channel := model.Channel{
			Type:         constant.ChannelTypeOpenAI,
			Name:         name,
			Key:          key,
			BaseURL:      &baseURL,
			Models:       modelList,
			Group:        group,
			Status:       common.ChannelStatusEnabled,
			Tag:          &tag,
			ModelMapping: mappingPtr,
			CreatedTime:  common.GetTimestamp(),
		}
		channel.ChannelInfo = model.ChannelInfo{}
		if svc.Manifest.Channel.Priority != nil {
			channel.Priority = svc.Manifest.Channel.Priority
		}
		if svc.Manifest.Channel.Weight != nil {
			channel.Weight = svc.Manifest.Channel.Weight
		}
		if err := model.BatchInsertChannels([]model.Channel{channel}); err != nil {
			return nil, nil, fmt.Errorf("create channel: %w", err)
		}
		created, err := model.GetChannelsByTag(tag, true, true)
		if err == nil && len(created) > 0 {
			view.ID = created[0].Id
		}
	}
	model.InitChannelCache()
	return view, models, nil
}
