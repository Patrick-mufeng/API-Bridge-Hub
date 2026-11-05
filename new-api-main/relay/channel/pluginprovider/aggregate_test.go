package pluginprovider

import (
	"encoding/json"
	"strings"
	"testing"
)

// A streamed answer becomes the one-piece reply a client asked for: the
// text, the tool calls with their arguments put back together, and the
// usage the stream reported.
func TestAggregateStreamMakesOneReply(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"id":"chat-1","model":"glm-5.3","created":1793770374,"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}`,
		`data: {"id":"chat-1","model":"glm-5.3","choices":[{"index":0,"delta":{"content":" there"}}]}`,
		`data: {"id":"chat-1","model":"glm-5.3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
		`data: {"id":"chat-1","model":"glm-5.3","choices":[],"usage":{"prompt_tokens":25,"completion_tokens":4,"total_tokens":29}}`,
		"data: [DONE]",
		"",
	}, "\n")

	body, usage, err := aggregateStream(strings.NewReader(stream), "glm-5.3")
	if err != nil {
		t.Fatalf("aggregateStream: %v", err)
	}
	var got struct {
		Object  string `json:"object"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("the reply isn't JSON: %v\n%s", err, body)
	}
	if got.Object != "chat.completion" {
		t.Errorf("object = %q, want chat.completion", got.Object)
	}
	if len(got.Choices) != 1 {
		t.Fatalf("choices = %d, want 1", len(got.Choices))
	}
	if got.Choices[0].Message.Content != "Hello there" {
		t.Errorf("content = %q, want %q", got.Choices[0].Message.Content, "Hello there")
	}
	if got.Choices[0].Message.Role != "assistant" {
		t.Errorf("role = %q", got.Choices[0].Message.Role)
	}
	if got.Choices[0].FinishReason != "stop" {
		t.Errorf("finish_reason = %q, want stop", got.Choices[0].FinishReason)
	}
	if got.Usage.PromptTokens != 25 || got.Usage.CompletionTokens != 4 {
		t.Errorf("usage = %+v, want 25/4", got.Usage)
	}
	if usage == nil {
		t.Error("the usage the stream reported was dropped")
	}
}

// Tool calls stream in pieces: the name once, then the arguments a fragment
// at a time. They are put back together in order, and the finish reason says
// the turn was a tool call.
func TestAggregateStreamJoinsToolCalls(t *testing.T) {
	// the arguments arrive as JSON the vendor splits across frames, so the
	// frame payload itself is escaped JSON: build it rather than hand-write it
	frame := func(delta any) string {
		b, err := json.Marshal(map[string]any{
			"choices": []any{map[string]any{"index": 0, "delta": delta}},
		})
		if err != nil {
			t.Fatal(err)
		}
		return "data: " + string(b)
	}
	stream := strings.Join([]string{
		frame(map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{
			"index": 0, "id": "call_a", "type": "function",
			"function": map[string]any{"name": "get_weather", "arguments": `{"city":`},
		}}}),
		frame(map[string]any{"tool_calls": []any{map[string]any{
			"index": 0, "function": map[string]any{"arguments": `"Shanghai"}`},
		}}}),
		frame(map[string]any{"finish_reason": "tool_calls"}),
		"data: [DONE]",
		"",
	}, "\n")

	body, _, err := aggregateStream(strings.NewReader(stream), "m")
	if err != nil {
		t.Fatalf("aggregateStream: %v", err)
	}
	var got struct {
		Choices []struct {
			Message struct {
				Content   *string `json:"content"`
				ToolCalls []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("the reply isn't JSON: %v\n%s", err, body)
	}
	if len(got.Choices) != 1 {
		t.Fatalf("choices = %d, want 1", len(got.Choices))
	}
	c := got.Choices[0]
	if c.FinishReason != "tool_calls" {
		t.Errorf("finish_reason = %q, want tool_calls", c.FinishReason)
	}
	if len(c.Message.ToolCalls) != 1 {
		t.Fatalf("tool_calls = %d, want 1", len(c.Message.ToolCalls))
	}
	tc := c.Message.ToolCalls[0]
	if tc.Function.Name != "get_weather" {
		t.Errorf("name = %q", tc.Function.Name)
	}
	if tc.Function.Arguments != `{"city":"Shanghai"}` {
		t.Errorf("arguments = %q", tc.Function.Arguments)
	}
	// a message that is a tool call has no content, as OpenAI sends it
	if c.Message.Content != nil {
		t.Errorf("content = %v, want null", *c.Message.Content)
	}
}

// A stream that carried nothing usable is an error rather than an empty
// reply: an empty reply would be billed as a successful turn.
func TestAggregateStreamRefusesAnEmptyStream(t *testing.T) {
	if _, _, err := aggregateStream(strings.NewReader("data: [DONE]\n"), "m"); err == nil {
		t.Fatal("an empty stream was accepted")
	}
}

// A vendor's error frame is the error, not silently dropped.
func TestAggregateStreamReportsVendorError(t *testing.T) {
	stream := `data: {"error":{"message":"content blocked","type":"bad_request"}}` + "\n"
	if _, _, err := aggregateStream(strings.NewReader(stream), "m"); err == nil {
		t.Fatal("a vendor error frame was accepted")
	}
}

// forceStream makes a body ask for a stream, as a vendor that answers only
// streams needs, and leaves one that doesn't parse alone.
func TestForceStream(t *testing.T) {
	out := forceStream([]byte(`{"model":"m","stream":false,"messages":[]}`))
	var got map[string]any
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got["stream"] != true {
		t.Errorf("stream = %v, want true", got["stream"])
	}
	if got["stream_options"] == nil {
		t.Error("stream_options wasn't added, so usage would be missing")
	}
	if string(forceStream([]byte("not json"))) != "not json" {
		t.Error("a body that isn't JSON was changed")
	}
}
