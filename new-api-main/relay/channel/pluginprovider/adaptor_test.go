package pluginprovider

import (
	"testing"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
)

// A model is spoken to with the protocol its AI SDK package names: that is
// what decides which built-in adaptor converts the request and parses the
// reply, so a plugin listing an Anthropic or Google model must not be sent
// OpenAI's chat protocol.
func TestProtocolOfPackage(t *testing.T) {
	cases := []struct {
		npm  string
		want protocol
	}{
		{"@ai-sdk/anthropic", anthropic},
		{"@ai-sdk/google", google},
		{"@ai-sdk/google-vertex", google},
		{"@ai-sdk/openai-compatible", chat},
		{"@ai-sdk/openai", chat},
		{"@ai-sdk/github-copilot", chat},
		{"@ai-sdk/xai", chat},
		{"", chat},
		{"  @ai-sdk/anthropic  ", anthropic},
	}
	for _, c := range cases {
		if got := protocolOf(c.npm); got != c.want {
			t.Errorf("protocolOf(%q) = %v, want %v", c.npm, got, c.want)
		}
	}
}

// The account a channel's requests go as is the key it holds; a channel
// with the provider id as its key, or with none, is the provider's first
// account, which the host resolves itself.
func TestAccountOf(t *testing.T) {
	cases := []struct {
		key, base, want string
	}{
		{"workbuddy#xbpn48", "workbuddy", "workbuddy#xbpn48"},
		{"", "workbuddy", ""},
		{"  workbuddy#a  ", "workbuddy", "workbuddy#a"},
		// a channel whose key is the provider id names no account of its own
		{"workbuddy", "workbuddy", ""},
	}
	for _, c := range cases {
		info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ApiKey: c.key, ChannelBaseUrl: c.base}}
		if got := accountOf(info); got != c.want {
			t.Errorf("accountOf(key=%q, base=%q) = %q, want %q", c.key, c.base, got, c.want)
		}
	}
}

// An empty provider id is refused rather than sent somewhere unexpected: a
// channel someone made without a Base URL must fail loudly.
func TestResolveNeedsProvider(t *testing.T) {
	a := &Adaptor{}
	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelBaseUrl: "  ", UpstreamModelName: "glm-5.3"}}
	if _, err := a.resolve(nil, info); err == nil {
		t.Fatal("resolve accepted an empty provider id")
	}
}
