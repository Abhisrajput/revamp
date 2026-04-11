package config

import (
	"fmt"

	"github.com/kelseyhightower/envconfig"
)

// Config holds all application configuration
type Config struct {
	// Server
	Port        string `envconfig:"PORT" default:"8080"`
	Environment string `envconfig:"ENVIRONMENT" default:"development"`
	LogLevel    string `envconfig:"LOG_LEVEL" default:"info"`

	// Redis
	RedisURL string `envconfig:"REDIS_URL" default:"redis://localhost:6379"`

	// OpenAI
	OpenAIAPIKey   string `envconfig:"OPENAI_API_KEY"`
	OpenAIEndpoint string `envconfig:"OPENAI_ENDPOINT" default:"https://api.openai.com/v1"`

	// Anthropic
	AnthropicAPIKey   string `envconfig:"ANTHROPIC_API_KEY"`
	AnthropicEndpoint string `envconfig:"ANTHROPIC_ENDPOINT" default:"https://api.anthropic.com"`

	// Google Gemini
	GeminiAPIKey  string `envconfig:"GEMINI_API_KEY"`
	GeminiProject string `envconfig:"GCP_PROJECT_ID"`
	GeminiRegion  string `envconfig:"GCP_REGION" default:"us-central1"`

	// AWS Bedrock
	AWSRegion          string `envconfig:"AWS_REGION" default:"us-east-2"`
	AWSAccessKeyID     string `envconfig:"AWS_ACCESS_KEY_ID"`
	AWSSecretAccessKey string `envconfig:"AWS_SECRET_ACCESS_KEY"`
	AWSSessionToken    string `envconfig:"AWS_SESSION_TOKEN"`

	// Google Vertex AI
	VertexAIProjectID          string `envconfig:"VERTEX_AI_PROJECT_ID"`
	VertexAILocation           string `envconfig:"VERTEX_AI_LOCATION" default:"us-central1"`
	VertexAIServiceAccountJSON string `envconfig:"VERTEX_AI_SERVICE_ACCOUNT_JSON"` // optional, uses ADC if empty

	// Azure AI Foundry (Azure OpenAI)
	AzureOpenAIEndpoint    string `envconfig:"AZURE_OPENAI_ENDPOINT"`                                   // https://<resource>.openai.azure.com
	AzureOpenAIAPIKey      string `envconfig:"AZURE_OPENAI_API_KEY"`
	AzureOpenAIAPIVersion  string `envconfig:"AZURE_OPENAI_API_VERSION" default:"2024-12-01-preview"`
	AzureOpenAIDeployments string `envconfig:"AZURE_OPENAI_DEPLOYMENTS"`                                // comma-separated deployment names

	// Ollama (local LLM — no API key needed)
	OllamaEndpoint string `envconfig:"OLLAMA_ENDPOINT"` // e.g. http://localhost:11434
	OllamaModels   string `envconfig:"OLLAMA_MODELS"`   // comma-separated: "qwen2.5-coder:1.5b,llama3.2"

	// Circuit Breaker
	CircuitBreakerThreshold int `envconfig:"CIRCUIT_BREAKER_THRESHOLD" default:"5"`
	CircuitBreakerTimeout   int `envconfig:"CIRCUIT_BREAKER_TIMEOUT" default:"60"`

	// Load Balancing
	DefaultProvider string `envconfig:"DEFAULT_PROVIDER" default:"openai"`

	// Worker Pool
	WorkerCount int `envconfig:"WORKER_COUNT" default:"10"`
	QueueSize   int `envconfig:"QUEUE_SIZE" default:"1000"`

	// Caching
	CacheTTL     int  `envconfig:"CACHE_TTL" default:"3600"`
	CacheEnabled bool `envconfig:"CACHE_ENABLED" default:"true"`

	// Rate Limiting
	RateLimitPerMinute int `envconfig:"RATE_LIMIT_PER_MINUTE" default:"100"`
	RateLimitPerDay    int `envconfig:"RATE_LIMIT_PER_DAY" default:"10000"`

	// Auth
	APIKey string `envconfig:"API_KEY"`

	// Streaming
	StreamTimeout int `envconfig:"STREAM_TIMEOUT" default:"300"`

	// Database (for Agent Department coordinator)
	DatabaseURL string `envconfig:"DATABASE_URL"`

	// Jira Integration
	JiraBaseURL    string `envconfig:"JIRA_BASE_URL"`
	JiraEmail      string `envconfig:"JIRA_EMAIL"`
	JiraAPIToken   string `envconfig:"JIRA_API_TOKEN"`
	JiraProjectKey string `envconfig:"JIRA_PROJECT_KEY"`

	// Metrics
	MetricsPort string `envconfig:"METRICS_PORT" default:"9090"`
}

// Load loads configuration from environment variables
func Load() (*Config, error) {
	var cfg Config
	if err := envconfig.Process("", &cfg); err != nil {
		return nil, fmt.Errorf("failed to process environment config: %w", err)
	}

	// Validate: warn if no global LLM provider is configured.
	// The orchestrator can still function with BYOK (per-request ephemeral credentials),
	// so this is no longer a fatal error.
	hasCloudProvider := cfg.OpenAIAPIKey != "" || cfg.AnthropicAPIKey != "" || cfg.GeminiAPIKey != ""
	hasBedrock := cfg.AWSAccessKeyID != ""
	hasVertexAI := cfg.VertexAIProjectID != ""
	hasAzure := cfg.AzureOpenAIEndpoint != "" && cfg.AzureOpenAIAPIKey != ""
	hasOllama := cfg.OllamaEndpoint != ""

	if !hasCloudProvider && !hasBedrock && !hasVertexAI && !hasAzure && !hasOllama {
		fmt.Println("[WARN] No global LLM provider configured. Only BYOK (per-request credentials) will work.")
	}

	return &cfg, nil
}

// IsProduction returns true if environment is production
func (c *Config) IsProduction() bool {
	return c.Environment == "production"
}

// GetLogLevel returns the log level
func (c *Config) GetLogLevel() string {
	return c.LogLevel
}
