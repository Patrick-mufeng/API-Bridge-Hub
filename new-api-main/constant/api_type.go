package constant

const (
	APITypeOpenAI = iota
	APITypeAnthropic
	APITypePaLM
	APITypeBaidu
	APITypeZhipu
	APITypeAli
	APITypeXunfei
	APITypeAIProxyLibrary
	APITypeTencent
	APITypeGemini
	APITypeZhipuV4
	APITypeOllama
	APITypePerplexity
	APITypeAws
	APITypeCohere
	APITypeDify
	APITypeJina
	APITypeCloudflare
	APITypeSiliconFlow
	APITypeVertexAi
	APITypeMistral
	APITypeDeepSeek
	APITypeMokaAI
	APITypeVolcEngine
	APITypeBaiduV2
	APITypeOpenRouter
	APITypeXinference
	APITypeXai
	APITypeCoze
	APITypeJimeng
	APITypeMoonshot
	APITypeSubmodel
	APITypeMiniMax
	APITypeReplicate
	APITypeCodex
	APITypeAdvancedCustom
	APITypeSub2API
	APITypeNewAPI
	// APITypePluginProvider is a provider a plugin-host plugin serves; its
	// adaptor speaks whichever protocol each model's AI SDK package does.
	APITypePluginProvider
	APITypeDummy // this one is only for count, do not add any channel after this
)
