package pluginprovider

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Some vendors answer a plugin's chat endpoint in one form only: WorkBuddy
// refuses a non-streamed chat outright ("Non-stream chat request is
// currently not supported", 400). A client of this relay may still ask for
// one, so the plugin is asked for a stream and the answer is put together
// here, in the shape the client asked for.
//
// This is the same thing new-api does for its own upstreams that need it
// (a Responses-only vendor served on Chat, and the reverse), kept in this
// package because only a plugin knows its vendor's one form.

// aggregated is a streamed answer put together as one reply.
type aggregated struct {
	ID        string
	Model     string
	Created   int64
	Content   strings.Builder
	Reasoning strings.Builder
	// Calls are the tool calls by index, in the order they first appeared.
	Calls   []*aggCall
	byIndex map[int]*aggCall
	Finish  string
	Usage   json.RawMessage
	// Role is the delta's role, kept for the reply's message.
	Role string
	// SystemFingerprint is passed through when the vendor gave one.
	SystemFingerprint string
}

type aggCall struct {
	Index   int    `json:"index"`
	ID      string `json:"id,omitempty"`
	Type    string `json:"type,omitempty"`
	Name    string
	Args    strings.Builder
	Thought string
}

// aggregateStream reads an SSE stream of chat chunks and returns one
// non-streamed chat completion, plus the usage it saw.
func aggregateStream(body io.Reader, model string) ([]byte, *usageOut, error) {
	a := &aggregated{byIndex: map[int]*aggCall{}}
	sc := bufio.NewScanner(body)
	// a vendor's frame can carry a long tool argument: 4 MB is well past
	// any real one, and past it the scanner would stop silently
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	sawAny := false
	for {
		var chunk struct {
			ID      string `json:"id"`
			Model   string `json:"model"`
			Created int64  `json:"created"`
			Choices []struct {
				Delta struct {
					Role             string          `json:"role"`
					Content          json.RawMessage `json:"content"`
					ReasoningContent string          `json:"reasoning_content"`
					Reasoning        string          `json:"reasoning"`
					ToolCalls        []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Type     string `json:"type"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				Message *struct {
					Role             string          `json:"role"`
					Content          json.RawMessage `json:"content"`
					ReasoningContent string          `json:"reasoning_content"`
				} `json:"message"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
			Usage             json.RawMessage `json:"usage"`
			Error             json.RawMessage `json:"error"`
			SystemFingerprint string          `json:"system_fingerprint"`
		}
		data, done := nextFrame(sc)
		if done {
			break
		}
		if data == "" {
			continue
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			// a frame that isn't JSON is passed over: some vendors put a
			// heartbeat or a comment there
			continue
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return nil, nil, fmt.Errorf("the vendor answered with an error: %s", strings.TrimSpace(string(chunk.Error)))
		}
		if chunk.ID != "" && a.ID == "" {
			a.ID = chunk.ID
		}
		if chunk.Model != "" {
			a.Model = chunk.Model
		}
		if chunk.Created != 0 {
			a.Created = chunk.Created
		}
		if chunk.SystemFingerprint != "" {
			a.SystemFingerprint = chunk.SystemFingerprint
		}
		if len(chunk.Usage) > 0 && string(chunk.Usage) != "null" {
			a.Usage = chunk.Usage
		}
		for _, ch := range chunk.Choices {
			sawAny = true
			if ch.Delta.Role != "" && a.Role == "" {
				a.Role = ch.Delta.Role
			}
			appendContent(&a.Content, ch.Delta.Content)
			if ch.Delta.ReasoningContent != "" {
				a.Reasoning.WriteString(ch.Delta.ReasoningContent)
			} else if ch.Delta.Reasoning != "" {
				a.Reasoning.WriteString(ch.Delta.Reasoning)
			}
			if ch.Message != nil {
				appendContent(&a.Content, ch.Message.Content)
				if ch.Message.ReasoningContent != "" {
					a.Reasoning.WriteString(ch.Message.ReasoningContent)
				}
			}
			for _, tc := range ch.Delta.ToolCalls {
				c, ok := a.byIndex[tc.Index]
				if !ok {
					c = &aggCall{Index: tc.Index}
					a.byIndex[tc.Index] = c
					a.Calls = append(a.Calls, c)
				}
				if tc.ID != "" {
					c.ID = tc.ID
				}
				if tc.Type != "" {
					c.Type = tc.Type
				}
				if tc.Function.Name != "" {
					c.Name += tc.Function.Name
				}
				c.Args.WriteString(tc.Function.Arguments)
			}
			if ch.FinishReason != nil && *ch.FinishReason != "" {
				a.Finish = *ch.FinishReason
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, nil, err
	}
	if !sawAny {
		return nil, nil, errors.New("the stream carried no choices")
	}
	out, err := a.build(model)
	if err != nil {
		return nil, nil, err
	}
	var u *usageOut
	if len(a.Usage) > 0 {
		u = &usageOut{raw: a.Usage}
	}
	return out, u, nil
}

// appendContent adds a delta's content, which is a string for most vendors
// and an array of parts for some.
func appendContent(b *strings.Builder, raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		b.WriteString(s)
		return
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		for _, p := range parts {
			if p.Type == "" || p.Type == "text" {
				b.WriteString(p.Text)
			}
		}
	}
}

// build is the aggregated answer as a non-streamed chat completion.
func (a *aggregated) build(model string) ([]byte, error) {
	if a.Model == "" {
		a.Model = model
	}
	if a.ID == "" {
		a.ID = "chatcmpl-plugin"
	}
	msg := map[string]any{"role": firstNonEmpty(a.Role, "assistant"), "content": a.Content.String()}
	if a.Reasoning.Len() > 0 {
		msg["reasoning_content"] = a.Reasoning.String()
	}
	if len(a.Calls) > 0 {
		calls := make([]map[string]any, 0, len(a.Calls))
		for i, c := range a.Calls {
			idx := c.Index
			if idx == 0 && i > 0 {
				idx = i
			}
			id := c.ID
			if id == "" {
				id = fmt.Sprintf("call_%d", idx)
			}
			calls = append(calls, map[string]any{
				"index": idx,
				"id":    id,
				"type":  firstNonEmpty(c.Type, "function"),
				"function": map[string]any{
					"name":      c.Name,
					"arguments": c.Args.String(),
				},
			})
		}
		msg["tool_calls"] = calls
		// a message with tool calls has no content
		if a.Content.Len() == 0 {
			msg["content"] = nil
		}
	}
	choice := map[string]any{
		"index":         0,
		"message":       msg,
		"finish_reason": firstNonEmpty(a.Finish, finishFor(a)),
		"logprobs":      nil,
	}
	body := map[string]any{
		"id":      a.ID,
		"object":  "chat.completion",
		"created": a.Created,
		"model":   a.Model,
		"choices": []any{choice},
	}
	if a.SystemFingerprint != "" {
		body["system_fingerprint"] = a.SystemFingerprint
	}
	if len(a.Usage) > 0 {
		body["usage"] = a.Usage
	}
	if body["created"] == int64(0) {
		body["created"] = nowUnix()
	}
	return json.Marshal(body)
}

func finishFor(a *aggregated) string {
	if len(a.Calls) > 0 {
		return "tool_calls"
	}
	return "stop"
}

// usageOut carries the usage an aggregated stream reported, so the relay
// bills the same numbers it would have seen from a one-piece reply.
type usageOut struct {
	raw json.RawMessage
}

// response builds the *http.Response the relay parses as a non-streamed
// reply.
func (u *usageOut) response(body []byte) *http.Response {
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	return &http.Response{
		StatusCode:    http.StatusOK,
		Status:        "200 OK",
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        h,
		Body:          io.NopCloser(bytes.NewReader(body)),
		ContentLength: int64(len(body)),
	}
}

// nextFrame reads SSE lines until one "data:" frame's payload is in hand.
// It returns ("", true) at the end of the stream, ("", false) for a line
// that carries no payload (a comment, an event name, a blank line).
func nextFrame(sc *bufio.Scanner) (string, bool) {
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		payload, ok := strings.CutPrefix(line, "data:")
		if !ok {
			continue
		}
		payload = strings.TrimSpace(payload)
		if payload == "" {
			continue
		}
		if payload == "[DONE]" {
			return "", true
		}
		return payload, false
	}
	return "", true
}

func nowUnix() int64 { return time.Now().Unix() }
