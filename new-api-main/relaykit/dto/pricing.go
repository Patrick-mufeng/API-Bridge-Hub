package dto

import "github.com/QuantumNous/new-api/relaykit/types"

// 这里不好动就不动了，本来想独立出来的（
type OpenAIModels struct {
	Id                     string               `json:"id"`
	Object                 string               `json:"object"`
	Created                int                  `json:"created"`
	OwnedBy                string               `json:"owned_by"`
	SupportedEndpointTypes []types.EndpointType `json:"supported_endpoint_types"`
	// ContextLength and MaxOutputTokens mirror the upstream-declared context
	// budget. Clients size their prompts from these, so leaving them out makes
	// every consumer fall back to a guessed window.
	ContextLength   int `json:"context_length,omitempty"`
	MaxOutputTokens int `json:"max_output_tokens,omitempty"`
}

type AnthropicModel struct {
	ID          string `json:"id"`
	CreatedAt   string `json:"created_at"`
	DisplayName string `json:"display_name"`
	Type        string `json:"type"`
}

type GeminiModel struct {
	Name                       any   `json:"name"`
	BaseModelId                any   `json:"baseModelId"`
	Version                    any   `json:"version"`
	DisplayName                any   `json:"displayName"`
	Description                any   `json:"description"`
	InputTokenLimit            any   `json:"inputTokenLimit"`
	OutputTokenLimit           any   `json:"outputTokenLimit"`
	SupportedGenerationMethods []any `json:"supportedGenerationMethods"`
	Thinking                   any   `json:"thinking"`
	Temperature                any   `json:"temperature"`
	MaxTemperature             any   `json:"maxTemperature"`
	TopP                       any   `json:"topP"`
	TopK                       any   `json:"topK"`
}
