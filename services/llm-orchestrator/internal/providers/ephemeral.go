package providers

import (
	"fmt"
	"strings"

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
			region = "us-east-2"
		}
		// Prefer bearer token auth
		if creds.AWSBearerToken != "" {
			return NewBedrockProviderWithBearerToken(creds.AWSBearerToken, region, logger), nil
		}
		// Explicit IAM credentials (long-term or STS)
		if creds.AWSAccessKeyID != "" && creds.AWSSecretKey != "" {
			return NewBedrockProviderWithCreds(creds.AWSAccessKeyID, creds.AWSSecretKey, creds.AWSSessionToken, region, logger)
		}
		// No explicit credentials — fall back to AWS default credential chain
		// (supports SSO profiles, instance roles, env vars, credential files)
		return NewBedrockProviderWithDefaultChain(region, creds.AWSSSOProfile, logger)

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

	case "vertexai":
		projectID := creds.VertexAIProjectID
		if projectID == "" {
			return nil, fmt.Errorf("vertexai requires vertex_ai_project_id")
		}
		location := creds.VertexAILocation
		if location == "" {
			location = "us-central1"
		}
		if creds.VertexAIServiceAccountJSON != "" {
			return NewVertexAIProviderWithServiceAccount(projectID, location, creds.VertexAIServiceAccountJSON, logger), nil
		}
		if creds.VertexAIAccessToken != "" {
			return NewVertexAIProviderWithAccessToken(projectID, location, creds.VertexAIAccessToken, logger), nil
		}
		return NewVertexAIProvider(projectID, location, logger), nil

	case "azure":
		endpoint := creds.AzureEndpoint
		if endpoint == "" {
			return nil, fmt.Errorf("azure requires azure_endpoint")
		}
		apiVersion := creds.AzureAPIVersion
		if apiVersion == "" {
			apiVersion = "2024-12-01-preview"
		}
		var deployments []string
		if creds.AzureDeployments != "" {
			for _, d := range strings.Split(creds.AzureDeployments, ",") {
				d = strings.TrimSpace(d)
				if d != "" {
					deployments = append(deployments, d)
				}
			}
		}
		if creds.AzureAPIKey != "" {
			return NewAzureProvider(endpoint, creds.AzureAPIKey, deployments, apiVersion, logger), nil
		}
		if creds.AzureADToken != "" {
			return NewAzureProviderWithADToken(endpoint, creds.AzureADToken, deployments, apiVersion, logger), nil
		}
		return nil, fmt.Errorf("azure requires azure_api_key or azure_ad_token")

	default:
		return nil, fmt.Errorf("unsupported provider: %s", creds.Provider)
	}
}
