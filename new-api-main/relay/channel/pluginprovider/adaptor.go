// Package pluginprovider serves a channel whose provider is a plugin-host
// plugin: the plugin signs the account in, lists the provider's models and
// makes each request on the vendor's wire, and this adaptor is what new-api
// needs around it.
//
// A model is spoken to with the AI SDK package its plugin lists it with
// (`npm`), which is the protocol the vendor answers in. That is what picks
// the adaptor whose request conversion and reply parsing are reused here:
// an `@ai-sdk/openai-compatible` model is OpenAI's chat protocol, an
// `@ai-sdk/anthropic` one is Messages, an `@ai-sdk/google` one is Gemini's.
// new-api's own conversion, streaming and usage accounting then run exactly
// as they do for those upstreams, so a plugin provider is billed and logged
// like any other channel.
package pluginprovider

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/logger"
	"github.com/QuantumNous/new-api/pkg/pluginhost"
	"github.com/QuantumNous/new-api/relay/channel"
	"github.com/QuantumNous/new-api/relay/channel/claude"
	"github.com/QuantumNous/new-api/relay/channel/gemini"
	"github.com/QuantumNous/new-api/relay/channel/openai"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/gin-gonic/gin"
)

const (
	// ChannelName is what the channel list calls this kind of channel.
	ChannelName = "Plugin Provider"
)

// Adaptor is a channel served by a plugin.
//
// ChannelBaseUrl carries the plugin's provider id (workbuddy, cursor…), and
// ApiKey carries the account the requests go as — the plugin's own key for
// it, which is provider or provider#xxxxxx. An account with no key of its
// own is the provider's first, so "" works too.
type Adaptor struct{}

// protocol is how a model is spoken to, which AI SDK package it names.
type protocol int

const (
	chat protocol = iota // OpenAI Chat Completions
	anthropic
	google
)

// protocolOf maps a model's AI SDK package to the protocol its vendor
// answers in. An unknown package is OpenAI-compatible: it is what a plugin
// listing its own models without one means, and what most of them are.
func protocolOf(npm string) protocol {
	switch strings.TrimSpace(npm) {
	case "@ai-sdk/anthropic":
		return anthropic
	case "@ai-sdk/google", "@ai-sdk/google-vertex":
		return google
	}
	return chat
}

// delegate is the built-in adaptor whose conversion and parsing this
// package reuses for a protocol.
func delegate(p protocol) channel.Adaptor {
	switch p {
	case anthropic:
		return &claude.Adaptor{}
	case google:
		return &gemini.Adaptor{}
	}
	return &openai.Adaptor{ChannelType: constant.ChannelTypeOpenAI}
}

// route is what one request needs from the plugins: which package speaks to
// the model, where the loader says the request goes, and the protocol.
type route struct {
	provider  string
	model     string
	npm       string
	baseURL   string
	apiID     string
	proto     protocol
	channelIs int
}

// resolve asks the plugins about the provider the channel names.
func (a *Adaptor) resolve(ctx *gin.Context, info *relaycommon.RelayInfo) (route, error) {
	r := route{
		provider:  strings.TrimSpace(info.ChannelBaseUrl),
		model:     info.UpstreamModelName,
		channelIs: info.ChannelType,
	}
	if r.provider == "" {
		return r, errors.New("this channel names no plugin provider: set its Base URL to the provider id, such as workbuddy")
	}
	ps, err := pluginhost.Providers(ctx.Request.Context())
	if err != nil {
		return r, fmt.Errorf("read the plugins' providers: %w", err)
	}
	var found *pluginhost.Provider
	for i := range ps {
		if ps[i].ID == r.provider {
			found = &ps[i]
			break
		}
	}
	if found == nil {
		return r, fmt.Errorf("no installed plugin serves the provider %q", r.provider)
	}
	if !found.SignedIn {
		return r, fmt.Errorf("%s has no account signed in: sign one in on the plugin host's page", found.Name)
	}
	r.npm = found.NPM
	r.apiID = r.model
	var m *pluginhost.Model
	for i := range found.Models {
		if found.Models[i].ID == r.model {
			m = &found.Models[i]
			break
		}
	}
	if m != nil {
		if m.NPM != "" {
			r.npm = m.NPM
		}
		if m.APIID != "" {
			r.apiID = m.APIID
		}
	}
	r.proto = protocolOf(r.npm)
	// the loader's base is the provider's, said once for all its models; the
	// model's own api.url is where a model served elsewhere lives
	opts, err := pluginhost.LoaderOptions(ctx.Request.Context(), r.provider, accountOf(info))
	if err != nil {
		return r, fmt.Errorf("%s's plugin wouldn't load: %w", found.Name, err)
	}
	r.baseURL = strings.TrimRight(firstNonEmpty(opts.BaseURL, modelURL(m), found.API), "/")
	if r.baseURL == "" {
		return r, fmt.Errorf("%s's plugin says nowhere to send its requests", found.Name)
	}
	if r.proto == anthropic && m != nil && strings.HasSuffix(strings.TrimRight(m.URL, "/"), "/v1") && !strings.HasSuffix(r.baseURL, "/v1") {
		// an Anthropic model whose own URL ends in /v1 is served under the
		// loader's base + /v1 (Copilot's, for one)
		r.baseURL += "/v1"
	}
	return r, nil
}

// forceStream makes a body ask for a stream, which some vendors insist on.
// A body that doesn't parse is passed through: the vendor's own error is a
// better answer than this function's guess.
func forceStream(body []byte) []byte {
	if len(body) == 0 {
		return body
	}
	var obj map[string]any
	if json.Unmarshal(body, &obj) != nil {
		return body
	}
	obj["stream"] = true
	// a streamed vendor reports usage only when asked to
	if _, has := obj["stream_options"]; !has {
		obj["stream_options"] = map[string]any{"include_usage": true}
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return body
	}
	return out
}

// putTogether reads the streamed answer and gives back the non-streamed
// response the relay then parses as usual.
func putTogether(resp *http.Response, model string) (*http.Response, error) {
	if resp == nil || resp.Body == nil {
		return nil, errors.New("the plugin answered nothing")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return nil, fmt.Errorf("the vendor answered %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	body, usage, err := aggregateStream(resp.Body, model)
	if err != nil {
		return nil, err
	}
	_ = usage
	return &http.Response{
		StatusCode:    http.StatusOK,
		Status:        "200 OK",
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        http.Header{"Content-Type": []string{"application/json"}},
		Body:          io.NopCloser(bytes.NewReader(body)),
		ContentLength: int64(len(body)),
	}, nil
}

func modelURL(m *pluginhost.Model) string {
	if m == nil {
		return ""
	}
	return m.URL
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if strings.TrimSpace(x) != "" {
			return x
		}
	}
	return ""
}

// accountOf is the plugin account this channel's requests go as: the key it
// holds, or "" for the provider's first account.
func accountOf(info *relaycommon.RelayInfo) string {
	key := strings.TrimSpace(info.ApiKey)
	if key == "" || key == info.ChannelBaseUrl {
		return ""
	}
	return key
}

func (a *Adaptor) Init(info *relaycommon.RelayInfo) {}

// GetRequestURL is where the request would go, for the log. The plugin
// sends it, so this is the vendor's own address rather than new-api's.
func (a *Adaptor) GetRequestURL(info *relaycommon.RelayInfo) (string, error) {
	r := route{provider: info.ChannelBaseUrl, model: info.UpstreamModelName}
	if r.provider == "" {
		return "", errors.New("this channel names no plugin provider: set its Base URL to the provider id")
	}
	return "plugin://" + r.provider + "/" + strings.TrimPrefix(info.RequestURLPath, "/"), nil
}

func (a *Adaptor) SetupRequestHeader(c *gin.Context, header *http.Header, info *relaycommon.RelayInfo) error {
	// the plugin writes the vendor's headers itself: the account's sign-in,
	// its client's User-Agent and whatever else its vendor insists on. What
	// new-api would set here would be replaced anyway.
	channel.SetupApiRequestHeader(info, c, header)
	return nil
}

func (a *Adaptor) ConvertOpenAIRequest(c *gin.Context, info *relaycommon.RelayInfo, request *dto.GeneralOpenAIRequest) (any, error) {
	r, err := a.resolve(c, info)
	if err != nil {
		return nil, err
	}
	return delegate(r.proto).ConvertOpenAIRequest(c, info, request)
}

func (a *Adaptor) ConvertClaudeRequest(c *gin.Context, info *relaycommon.RelayInfo, request *dto.ClaudeRequest) (any, error) {
	r, err := a.resolve(c, info)
	if err != nil {
		return nil, err
	}
	return delegate(r.proto).ConvertClaudeRequest(c, info, request)
}

func (a *Adaptor) ConvertGeminiRequest(c *gin.Context, info *relaycommon.RelayInfo, request *dto.GeminiChatRequest) (any, error) {
	r, err := a.resolve(c, info)
	if err != nil {
		return nil, err
	}
	return delegate(r.proto).ConvertGeminiRequest(c, info, request)
}

func (a *Adaptor) ConvertOpenAIResponsesRequest(c *gin.Context, info *relaycommon.RelayInfo, request dto.OpenAIResponsesRequest) (any, error) {
	r, err := a.resolve(c, info)
	if err != nil {
		return nil, err
	}
	return delegate(r.proto).ConvertOpenAIResponsesRequest(c, info, request)
}

func (a *Adaptor) ConvertEmbeddingRequest(c *gin.Context, info *relaycommon.RelayInfo, request dto.EmbeddingRequest) (any, error) {
	r, err := a.resolve(c, info)
	if err != nil {
		return nil, err
	}
	return delegate(r.proto).ConvertEmbeddingRequest(c, info, request)
}

func (a *Adaptor) ConvertRerankRequest(c *gin.Context, relayMode int, request dto.RerankRequest) (any, error) {
	return nil, errors.New("a plugin provider serves no rerank")
}

func (a *Adaptor) ConvertAudioRequest(c *gin.Context, info *relaycommon.RelayInfo, request dto.AudioRequest) (io.Reader, error) {
	return nil, errors.New("a plugin provider serves no audio")
}

func (a *Adaptor) ConvertImageRequest(c *gin.Context, info *relaycommon.RelayInfo, request dto.ImageRequest) (any, error) {
	return nil, errors.New("a plugin provider serves no images")
}

// DoRequest hands the body to the plugin, which sends it on the vendor's
// wire as the account it is signed in to.
func (a *Adaptor) DoRequest(c *gin.Context, info *relaycommon.RelayInfo, requestBody io.Reader) (any, error) {
	r, err := a.resolve(c, info)
	if err != nil {
		return nil, types.NewError(err, types.ErrorCodeDoRequestFailed)
	}
	var body []byte
	if requestBody != nil {
		buf := bytes.NewBuffer(make([]byte, 0, 64<<10))
		if _, err := buf.ReadFrom(requestBody); err != nil {
			return nil, types.NewError(fmt.Errorf("read request body: %w", err), types.ErrorCodeReadRequestBodyFailed, types.ErrOptionWithSkipRetry())
		}
		body = buf.Bytes()
	}
	url, err := a.upstreamURL(r, info)
	if err != nil {
		return nil, types.NewError(err, types.ErrorCodeDoRequestFailed)
	}
	// A client that asked for no stream may still reach a vendor that
	// answers only streams (WorkBuddy refuses a non-streamed chat outright).
	// The plugin is asked for the stream either way, and a non-streamed
	// answer is put together in DoResponse.
	wantStream := info.IsStream
	if !wantStream {
		body = forceStream(body)
	}
	logger.LogDebug(c, "plugin provider %s: %s %s (npm %s)", r.provider, http.MethodPost, relaycommon.SanitizeURLForLog(url), r.npm)
	if wantStream {
		// SSE headers and the ping keep-alive, as any streaming upstream
		c.Writer.Header().Set("Content-Type", "text/event-stream")
		c.Writer.Header().Set("Cache-Control", "no-cache")
		c.Writer.Header().Set("Connection", "keep-alive")
		c.Writer.Header().Set("X-Accel-Buffering", "no")
	}
	resp, err := pluginhost.Fetch(c.Request.Context(), pluginhost.FetchRequest{
		Provider: r.provider,
		Account:  accountOf(info),
		Model:    r.apiID,
		NPM:      r.npm,
		URL:      url,
		Method:   http.MethodPost,
		Headers:  requestHeaders(c, info, !wantStream),
		Body:     body,
	})
	if err != nil {
		return nil, types.NewError(fmt.Errorf("%s's plugin: %w", r.provider, err), types.ErrorCodeDoRequestFailed)
	}
	if wantStream {
		return resp, nil
	}
	// The client asked for one piece; the vendor only streams. Put it
	// together here rather than in DoResponse: the relay reads the reply's
	// Content-Type to decide whether it is a stream, so an event stream
	// leaving this function would be relayed as one.
	agg, perr := putTogether(resp, r.apiID)
	if perr != nil {
		return nil, types.NewError(perr, types.ErrorCodeDoRequestFailed)
	}
	return agg, nil
}

// upstreamURL is where the plugin is asked to send the request: the base the
// loader gave, plus the path that protocol's own client would use.
func (a *Adaptor) upstreamURL(r route, info *relaycommon.RelayInfo) (string, error) {
	switch r.proto {
	case anthropic:
		// Messages is one endpoint whatever the client asked in: a Claude
		// client's /v1/messages and an OpenAI one converted to it both end
		// here
		return r.baseURL + "/messages", nil
	case google:
		path := strings.TrimPrefix(info.RequestURLPath, "/")
		if rest, ok := strings.CutPrefix(path, "v1beta/"); ok {
			path = rest
		}
		if rest, ok := strings.CutPrefix(path, "v1/"); ok {
			path = rest
		}
		if !strings.Contains(path, "models/") {
			path = "models/" + r.apiID + ":streamGenerateContent?alt=sse"
			if !info.IsStream {
				path = "models/" + r.apiID + ":generateContent"
			}
		}
		return r.baseURL + "/" + path, nil
	default:
		// an OpenAI-compatible base already ends at the API root; the AI
		// SDK appends /chat/completions to it
		if rest, ok := strings.CutPrefix(info.RequestURLPath, "/v1"); ok && rest != "" {
			return r.baseURL + rest, nil
		}
		if info.RelayMode == relayconstant.RelayModeResponses {
			return r.baseURL + "/responses", nil
		}
		return r.baseURL + "/chat/completions", nil
	}
}

// requestHeaders are what the request carries besides the plugin's own: the
// body's type, and the stream where the client asked for one. The account's
// sign-in is the plugin's to add, so no Authorization goes here.
func requestHeaders(c *gin.Context, info *relaycommon.RelayInfo, upstreamStreams bool) map[string]string {
	h := map[string]string{"Content-Type": "application/json"}
	if upstreamStreams {
		h["Accept"] = "text/event-stream"
	} else if accept := c.Request.Header.Get("Accept"); accept != "" {
		h["Accept"] = accept
	}
	if info.RelayFormat == types.RelayFormatClaude {
		h["anthropic-version"] = firstNonEmpty(c.Request.Header.Get("anthropic-version"), "2023-06-01")
	}
	if beta := c.Request.Header.Get("anthropic-beta"); beta != "" {
		h["anthropic-beta"] = beta
	}
	return h
}

// DoResponse parses the reply with the adaptor of the model's own protocol,
// so streaming, tool calls and usage are the ones new-api already knows.
func (a *Adaptor) DoResponse(c *gin.Context, resp *http.Response, info *relaycommon.RelayInfo) (usage any, err *types.NewAPIError) {
	r, rerr := a.resolve(c, info)
	if rerr != nil {
		return nil, types.NewError(rerr, types.ErrorCodeDoRequestFailed)
	}
	return delegate(r.proto).DoResponse(c, resp, info)
}

func (a *Adaptor) GetModelList() []string { return nil }

func (a *Adaptor) GetChannelName() string { return ChannelName }

// TestURL is not used: a plugin provider is tested by asking its plugin for
// a turn, which controller/channel-test does through the relay.
var _ = url.Parse
