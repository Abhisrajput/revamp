/**
 * Pipeline BYOK Credentials — resolves per-project LLM provider credentials.
 *
 * Reads provider config from project.settings.llmProviders and returns
 * a ProjectCredentials object for the Go LLM orchestrator.
 *
 * Supports: Bedrock (SSO/IAM/bearer), Anthropic, OpenAI, Gemini, VertexAI, Azure.
 */

import type { ProjectCredentials } from "./llm-proxy.js";

/**
 * Extract BYOK credentials from project settings.
 * Returns undefined if no providers configured.
 */
export function resolveProjectCredentials(
  projectSettings: Record<string, unknown> | null | undefined,
): ProjectCredentials | undefined {
  if (!projectSettings) return undefined;

  const llmProviders = (
    (projectSettings.llmProviders as Record<string, unknown>[])
    || (projectSettings.llm_providers as Record<string, unknown>[])
    || []
  );

  if (llmProviders.length === 0) return undefined;

  const defaultProvider = llmProviders.find((p: any) => p.is_default) || llmProviders[0];
  const ptype = (defaultProvider as any).provider_type as string;
  const apiKeyField = (defaultProvider as any).api_key_encrypted as string || "";

  const creds: ProjectCredentials = { provider: ptype };

  if (ptype === "bedrock") {
    let bearerToken: string | undefined;
    let parsed: Record<string, string> | undefined;

    if (typeof apiKeyField === "string" && apiKeyField.startsWith("{")) {
      try {
        parsed = JSON.parse(apiKeyField);
        bearerToken = parsed?.bearerToken || parsed?.bearer_token || parsed?.apiKey || parsed?.api_key;
      } catch {
        console.warn("[Pipeline] Failed to parse Bedrock credentials");
      }
    } else if (typeof apiKeyField === "string" && apiKeyField.length > 10) {
      bearerToken = apiKeyField;
    }

    if (bearerToken) {
      creds.aws_bearer_token = bearerToken;
      creds.aws_region = parsed?.region || parsed?.aws_region || "us-east-2";
    } else if (parsed?.ssoProfile || parsed?.sso_profile) {
      creds.aws_sso_profile = parsed.ssoProfile || parsed.sso_profile || "";
      creds.aws_region = parsed.region || parsed.aws_region || "us-east-2";
    } else if (parsed?.accessKeyId || parsed?.aws_access_key_id) {
      creds.aws_access_key_id = parsed.accessKeyId || parsed.aws_access_key_id || "";
      creds.aws_secret_access_key = parsed.secretAccessKey || parsed.aws_secret_access_key || "";
      creds.aws_session_token = parsed.sessionToken || parsed.aws_session_token || "";
      creds.aws_region = parsed.region || parsed.aws_region || "us-east-2";
    } else {
      creds.aws_region = parsed?.region || parsed?.aws_region || "us-east-2";
    }
  } else if (ptype === "anthropic") {
    creds.anthropic_api_key = apiKeyField;
  } else if (ptype === "openai") {
    creds.openai_api_key = apiKeyField;
    const baseUrl = (defaultProvider as any).base_url as string;
    if (baseUrl) creds.openai_endpoint = baseUrl;
  } else if (ptype === "gemini") {
    creds.gemini_api_key = apiKeyField;
  } else if (ptype === "vertexai") {
    try {
      const parsed = JSON.parse(apiKeyField);
      creds.vertex_ai_project_id = parsed.projectId || parsed.project_id || "";
      creds.vertex_ai_location = parsed.location || "us-central1";
      if (parsed.serviceAccountJson || parsed.service_account_json) {
        const saJson = parsed.serviceAccountJson || parsed.service_account_json;
        creds.vertex_ai_service_account_json = typeof saJson === "string" ? saJson : JSON.stringify(saJson);
      }
      if (parsed.accessToken || parsed.access_token) {
        creds.vertex_ai_access_token = parsed.accessToken || parsed.access_token;
      }
    } catch {
      creds.vertex_ai_access_token = apiKeyField;
    }
  } else if (ptype === "azure") {
    try {
      const parsed = JSON.parse(apiKeyField);
      creds.azure_endpoint = parsed.endpoint || "";
      creds.azure_api_version = parsed.apiVersion || parsed.api_version || "2024-12-01-preview";
      creds.azure_deployments = parsed.deployments || "";
      if (parsed.apiKey || parsed.api_key) creds.azure_api_key = parsed.apiKey || parsed.api_key;
      if (parsed.adToken || parsed.ad_token) creds.azure_ad_token = parsed.adToken || parsed.ad_token;
    } catch {
      creds.azure_api_key = apiKeyField;
      const baseUrl = (defaultProvider as any).base_url as string;
      if (baseUrl) creds.azure_endpoint = baseUrl;
    }
  }

  return creds;
}
