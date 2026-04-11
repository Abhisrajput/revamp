package providers

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/bedrock"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	cfg "github.com/revamp-io/llm-orchestrator/internal/config"
	"go.uber.org/zap"
)

// Registry holds all registered LLM providers
type Registry struct {
	providers map[string]LLMProvider
	mu        sync.RWMutex
	logger    *zap.Logger
	config    *cfg.Config
}

// NewRegistry creates a new provider registry
func NewRegistry(config *cfg.Config, logger *zap.Logger) *Registry {
	return &Registry{
		providers: make(map[string]LLMProvider),
		logger:    logger,
		config:    config,
	}
}

// RegisterProviders registers all available providers
func (r *Registry) RegisterProviders() error {
	// Register OpenAI (with optional custom endpoint for Azure/proxy support)
	if r.config.OpenAIAPIKey != "" {
		openaiProvider := NewOpenAIProviderWithEndpoint(r.config.OpenAIAPIKey, r.config.OpenAIEndpoint, r.logger)
		r.Register("openai", openaiProvider)
		r.logger.Info("Registered OpenAI provider", zap.String("endpoint", r.config.OpenAIEndpoint))
	}

	// Register Anthropic
	if r.config.AnthropicAPIKey != "" {
		anthropicProvider := NewAnthropicProvider(r.config.AnthropicAPIKey, r.logger)
		r.Register("anthropic", anthropicProvider)
		r.logger.Info("Registered Anthropic provider")
	}

	// Register Gemini
	if r.config.GeminiAPIKey != "" || r.config.GeminiProject != "" {
		geminiProvider := NewGeminiProvider(r.config.GeminiAPIKey, r.config.GeminiProject, r.logger)
		r.Register("gemini", geminiProvider)
		r.logger.Info("Registered Gemini provider")
	}

	// Register Bedrock — uses the AWS SDK default credential chain which supports:
	//   1. Env vars (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)
	//   2. SSO profiles (~/.aws/config + `aws sso login`)
	//   3. IAM instance roles (EC2/ECS)
	//   4. Credential process / credential file
	{
		bedrockProvider, err := r.createBedrockProvider()
		if err != nil {
			r.logger.Warn("Bedrock provider not available", zap.Error(err))
		} else {
			r.Register("bedrock", bedrockProvider)
			r.logger.Info("Registered Bedrock provider (default credential chain)")
		}
	}

	// Register Vertex AI
	if r.config.VertexAIProjectID != "" {
		var vertexProvider *VertexAIProvider
		if r.config.VertexAIServiceAccountJSON != "" {
			vertexProvider = NewVertexAIProviderWithServiceAccount(
				r.config.VertexAIProjectID, r.config.VertexAILocation,
				r.config.VertexAIServiceAccountJSON, r.logger,
			)
		} else {
			vertexProvider = NewVertexAIProvider(r.config.VertexAIProjectID, r.config.VertexAILocation, r.logger)
		}
		r.Register("vertexai", vertexProvider)
		r.logger.Info("Registered Vertex AI provider",
			zap.String("project", r.config.VertexAIProjectID),
			zap.String("location", r.config.VertexAILocation),
		)
	}

	// Register Azure AI Foundry (Azure OpenAI)
	if r.config.AzureOpenAIEndpoint != "" && r.config.AzureOpenAIAPIKey != "" {
		var deployments []string
		if r.config.AzureOpenAIDeployments != "" {
			for _, d := range strings.Split(r.config.AzureOpenAIDeployments, ",") {
				d = strings.TrimSpace(d)
				if d != "" {
					deployments = append(deployments, d)
				}
			}
		}
		azureProvider := NewAzureProvider(
			r.config.AzureOpenAIEndpoint, r.config.AzureOpenAIAPIKey,
			deployments, r.config.AzureOpenAIAPIVersion, r.logger,
		)
		r.Register("azure", azureProvider)
		r.logger.Info("Registered Azure AI Foundry provider",
			zap.String("endpoint", r.config.AzureOpenAIEndpoint),
			zap.Int("deployments", len(deployments)),
		)
	}

	// Register Ollama (local / self-hosted LLM)
	if r.config.OllamaEndpoint != "" {
		var models []string
		if r.config.OllamaModels != "" {
			for _, m := range strings.Split(r.config.OllamaModels, ",") {
				m = strings.TrimSpace(m)
				if m != "" {
					models = append(models, m)
				}
			}
		}
		ollamaProvider := NewOllamaProvider(r.config.OllamaEndpoint, models, r.logger)
		r.Register("ollama", ollamaProvider)
		r.logger.Info("Registered Ollama provider",
			zap.String("endpoint", r.config.OllamaEndpoint),
			zap.Strings("models", models),
		)
	}

	if len(r.providers) == 0 {
		return fmt.Errorf("no providers could be registered")
	}

	return nil
}

// createBedrockProvider creates a Bedrock provider with AWS credentials
func (r *Registry) createBedrockProvider() (LLMProvider, error) {
	ctx := context.Background()

	// Load AWS configuration
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}

	// Create Bedrock Runtime client
	bedrockRuntimeClient := bedrockruntime.NewFromConfig(cfg)
	bedrockClient := bedrock.NewFromConfig(cfg)

	return NewBedrockProvider(bedrockRuntimeClient, bedrockClient, r.logger), nil
}

// Register registers a provider
func (r *Registry) Register(name string, provider LLMProvider) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.providers[name] = provider
}

// Get returns a provider by name
func (r *Registry) Get(name string) (LLMProvider, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	provider, ok := r.providers[name]
	if !ok {
		return nil, fmt.Errorf("provider '%s' not found", name)
	}

	if !provider.IsAvailable() {
		return nil, fmt.Errorf("provider '%s' is not available", name)
	}

	return provider, nil
}

// GetByModel returns a provider that supports the given model
func (r *Registry) GetByModel(model string) (LLMProvider, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	for _, provider := range r.providers {
		if provider.IsAvailable() && provider.SupportsModel(model) {
			return provider, nil
		}
	}

	return nil, fmt.Errorf("no provider found for model '%s'", model)
}

// GetAll returns all registered providers
func (r *Registry) GetAll() []LLMProvider {
	r.mu.RLock()
	defer r.mu.RUnlock()

	providers := make([]LLMProvider, 0, len(r.providers))
	for _, p := range r.providers {
		providers = append(providers, p)
	}
	return providers
}

// GetAvailable returns all available providers
func (r *Registry) GetAvailable() []LLMProvider {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var available []LLMProvider
	for _, p := range r.providers {
		if p.IsAvailable() {
			available = append(available, p)
		}
	}
	return available
}

// modelMetadata provides context size and pricing info for known models.
// Models not in this table still appear — they get sensible defaults.
var modelMetadata = map[string]ModelInfo{
	// Anthropic — Claude 4.x
	"claude-opus-4-6":           {Name: "Claude Opus 4.6", ContextSize: 200000, CostPerInput: 0.015, CostPerOutput: 0.075, Owner: "Anthropic"},
	"claude-sonnet-4-6":         {Name: "Claude Sonnet 4.6", ContextSize: 200000, CostPerInput: 0.003, CostPerOutput: 0.015, Owner: "Anthropic"},
	"claude-haiku-4-5-20251001": {Name: "Claude Haiku 4.5", ContextSize: 200000, CostPerInput: 0.001, CostPerOutput: 0.005, Owner: "Anthropic"},
	// Anthropic — Claude 3.5
	"claude-3-5-sonnet-20241022": {Name: "Claude 3.5 Sonnet", ContextSize: 200000, CostPerInput: 0.003, CostPerOutput: 0.015, Owner: "Anthropic"},
	"claude-3-5-haiku-20241022":  {Name: "Claude 3.5 Haiku", ContextSize: 200000, CostPerInput: 0.001, CostPerOutput: 0.005, Owner: "Anthropic"},
	// Anthropic — Claude 3
	"claude-3-opus-20240229":   {Name: "Claude 3 Opus", ContextSize: 200000, CostPerInput: 0.015, CostPerOutput: 0.075, Owner: "Anthropic"},
	"claude-3-sonnet-20240229": {Name: "Claude 3 Sonnet", ContextSize: 200000, CostPerInput: 0.003, CostPerOutput: 0.015, Owner: "Anthropic"},
	"claude-3-haiku-20240307":  {Name: "Claude 3 Haiku", ContextSize: 200000, CostPerInput: 0.00025, CostPerOutput: 0.00125, Owner: "Anthropic"},
	// OpenAI — Chat Completions
	"gpt-4-turbo":   {Name: "GPT-4 Turbo", ContextSize: 128000, CostPerInput: 0.01, CostPerOutput: 0.03, Owner: "OpenAI"},
	"gpt-4":         {Name: "GPT-4", ContextSize: 8192, CostPerInput: 0.03, CostPerOutput: 0.06, Owner: "OpenAI"},
	"gpt-4o":        {Name: "GPT-4o", ContextSize: 128000, CostPerInput: 0.005, CostPerOutput: 0.015, Owner: "OpenAI"},
	"gpt-3.5-turbo": {Name: "GPT-3.5 Turbo", ContextSize: 16385, CostPerInput: 0.0005, CostPerOutput: 0.0015, Owner: "OpenAI"},
	// OpenAI — Responses API (gpt-5-codex family)
	"gpt-5-codex": {Name: "GPT-5 Codex", ContextSize: 200000, CostPerInput: 0.002, CostPerOutput: 0.008, Owner: "OpenAI"},
	// Google Gemini
	"gemini-2.0-flash": {Name: "Gemini 2.0 Flash", ContextSize: 1000000, CostPerInput: 0.000075, CostPerOutput: 0.00030, Owner: "Google"},
	"gemini-1.5-pro":   {Name: "Gemini 1.5 Pro", ContextSize: 2000000, CostPerInput: 0.00125, CostPerOutput: 0.005, Owner: "Google"},
	"gemini-1.5-flash": {Name: "Gemini 1.5 Flash", ContextSize: 1000000, CostPerInput: 0.000075, CostPerOutput: 0.00030, Owner: "Google"},
	// Google Vertex AI (same models, slightly different pricing)
	"gemini-2.5-pro":   {Name: "Gemini 2.5 Pro", ContextSize: 1000000, CostPerInput: 0.00125, CostPerOutput: 0.010, Owner: "Google (Vertex AI)"},
	"gemini-2.5-flash": {Name: "Gemini 2.5 Flash", ContextSize: 1000000, CostPerInput: 0.00015, CostPerOutput: 0.00060, Owner: "Google (Vertex AI)"},
}

// providerOwners maps provider name to display owner
var providerOwners = map[string]string{
	"openai":    "OpenAI",
	"anthropic": "Anthropic",
	"gemini":    "Google",
	"vertexai":  "Google (Vertex AI)",
	"bedrock":   "AWS",
	"azure":     "Microsoft (Azure AI Foundry)",
	"ollama":    "Local (Ollama)",
}

// ListModels returns all available models dynamically from registered providers.
// No hardcoded model lists — the source of truth is each provider's GetModels().
func (r *Registry) ListModels() map[string]ModelInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()

	models := make(map[string]ModelInfo)

	for _, provider := range r.providers {
		if !provider.IsAvailable() {
			continue
		}
		providerName := provider.Name()
		owner := providerOwners[providerName]
		if owner == "" {
			owner = providerName
		}

		for _, modelID := range provider.GetModels() {
			if meta, ok := modelMetadata[modelID]; ok {
				// Known model — use metadata for pricing/context
				models[modelID] = ModelInfo{
					ID:            modelID,
					Name:          meta.Name,
					Provider:      providerName,
					ContextSize:   meta.ContextSize,
					CostPerInput:  meta.CostPerInput,
					CostPerOutput: meta.CostPerOutput,
					Owner:         owner,
				}
			} else {
				// Unknown model — use sensible defaults
				models[modelID] = ModelInfo{
					ID:            modelID,
					Name:          modelID,
					Provider:      providerName,
					ContextSize:   128000, // safe default
					CostPerInput:  0,
					CostPerOutput: 0,
					Owner:         owner,
				}
			}
		}
	}

	return models
}

// GetHealth returns the health status of all providers
func (r *Registry) GetHealth() map[string]ProviderHealth {
	r.mu.RLock()
	defer r.mu.RUnlock()

	health := make(map[string]ProviderHealth)
	for name, provider := range r.providers {
		health[name] = provider.GetHealth()
	}
	return health
}
