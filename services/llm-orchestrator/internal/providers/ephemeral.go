package providers

import (
	"fmt"

	"go.uber.org/zap"
)

// CreateEphemeralProvider creates a temporary provider instance from per-request credentials.
// The provider is NOT registered in the global registry — it's used for a single request and discarded.
// This enables BYOK (Bring Your Own Key) per-project credentials.
func CreateEphemeralProvider(creds *RequestCredentials, logger *zap.Logger) (LLMProvider, error) {
	if creds == nil {
		return nil, fmt.Errorf("no credentials provided")
	}

	switch creds.Provider {
	case "bedrock":
		region := creds.AWSRegion
		if region == "" {
			region = "us-east-1"
		}
		// Prefer bearer token auth (Bedrock API key) — never expires, no IAM/STS needed
		if creds.AWSBearerToken != "" {
			return NewBedrockProviderWithBearerToken(creds.AWSBearerToken, region, logger), nil
		}
		if creds.AWSAccessKeyID == "" || creds.AWSSecretKey == "" {
			return nil, fmt.Errorf("bedrock requires aws_bearer_token OR (aws_access_key_id + aws_secret_access_key)")
		}
		return NewBedrockProviderWithCreds(creds.AWSAccessKeyID, creds.AWSSecretKey, creds.AWSSessionToken, region, logger)

	case "anthropic":
		if creds.AnthropicAPIKey == "" {
			return nil, fmt.Errorf("anthropic requires anthropic_api_key")
		}
		return NewAnthropicProvider(creds.AnthropicAPIKey, logger), nil

	case "openai":
		if creds.OpenAIAPIKey == "" {
			return nil, fmt.Errorf("openai requires openai_api_key")
		}
		endpoint := creds.OpenAIEndpoint
		if endpoint == "" {
			endpoint = "https://api.openai.com/v1"
		}
		return NewOpenAIProviderWithEndpoint(creds.OpenAIAPIKey, endpoint, logger), nil

	case "gemini":
		if creds.GeminiAPIKey == "" {
			return nil, fmt.Errorf("gemini requires gemini_api_key")
		}
		return NewGeminiProvider(creds.GeminiAPIKey, "", logger), nil

	default:
		return nil, fmt.Errorf("unsupported provider: %s", creds.Provider)
	}
}
