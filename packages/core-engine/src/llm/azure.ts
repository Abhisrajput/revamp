import { OpenAIProvider } from './openai.js';

/**
 * Azure AI Foundry / Azure OpenAI provider.
 *
 * Uses the same OpenAI SDK and API shape as OpenAIProvider — the only
 * difference is the endpoint, auth header, and api-version query param.
 *
 * Constructor reads from env:
 *   AZURE_OPENAI_ENDPOINT  — e.g. https://my-resource.openai.azure.com
 *   AZURE_OPENAI_API_KEY   — Azure resource key
 *   AZURE_API_VERSION      — defaults to 2024-10-21
 */
export class AzureProvider extends OpenAIProvider {
  override readonly name = 'azure';

  constructor(
    options: {
      endpoint?: string;
      apiKey?: string;
      apiVersion?: string;
    } = {},
  ) {
    const endpoint = options.endpoint || process.env.AZURE_OPENAI_ENDPOINT || '';
    const apiKey = options.apiKey || process.env.AZURE_OPENAI_API_KEY;
    const apiVersion =
      options.apiVersion || process.env.AZURE_API_VERSION || '2024-10-21';

    super({
      apiKey,
      baseURL: `${endpoint}/openai/deployments`,
      defaultQuery: { 'api-version': apiVersion },
      defaultHeaders: { 'api-key': apiKey },
    });
  }

  override models(): string[] {
    // Return common Azure deployment names; projects override per their own deployments.
    return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-35-turbo'];
  }
}
