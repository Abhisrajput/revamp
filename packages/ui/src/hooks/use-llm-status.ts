/**
 * Hook for tracking LLM provider health status
 * Polls health endpoints and manages provider availability state
 */

import { useEffect, useState, useCallback } from 'react';
import { LLMProvider, ProviderHealthStatus, LLMServiceStatus } from '@revamp/shared-types/llm';

export interface UseLLMStatusOptions {
  healthCheckUrl?: string;
  pollInterval?: number; // milliseconds, default 30000
  autoStart?: boolean;
  onStatusChange?: (status: LLMServiceStatus) => void;
  onError?: (error: Error) => void;
}

export interface UseLLMStatusReturn {
  status: LLMServiceStatus | null;
  isHealthy: boolean;
  isLoading: boolean;
  error: Error | null;
  providers: Record<LLMProvider, ProviderHealthStatus | null>;
  refresh: () => Promise<void>;
}

export function useLLMStatus({
  healthCheckUrl = '/api/health/llm',
  pollInterval = 30000,
  autoStart = true,
  onStatusChange,
  onError,
}: UseLLMStatusOptions): UseLLMStatusReturn {
  const [status, setStatus] = useState<LLMServiceStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(healthCheckUrl);

      if (!response.ok) {
        throw new Error(`Health check failed: ${response.statusText}`);
      }

      const data: LLMServiceStatus = await response.json();
      setStatus(data);
      onStatusChange?.(data);
    } catch (err) {
      const healthError = new Error(
        err instanceof Error ? err.message : 'Failed to fetch LLM health status',
      );
      setError(healthError);
      onError?.(healthError);
    } finally {
      setIsLoading(false);
    }
  }, [healthCheckUrl, onStatusChange, onError]);

  // Build providers map
  const providers: Record<LLMProvider, ProviderHealthStatus | null> = {
    [LLMProvider.OPENAI]: status?.providers.find((p) => p.provider === LLMProvider.OPENAI) || null,
    [LLMProvider.ANTHROPIC]: status?.providers.find((p) => p.provider === LLMProvider.ANTHROPIC) || null,
    [LLMProvider.GOOGLE]: status?.providers.find((p) => p.provider === LLMProvider.GOOGLE) || null,
    [LLMProvider.AWS_BEDROCK]: status?.providers.find((p) => p.provider === LLMProvider.AWS_BEDROCK) || null,
  };

  // Start polling
  useEffect(() => {
    if (!autoStart) return;

    setIsPolling(true);
    refresh();

    const pollTimer = setInterval(refresh, pollInterval);

    return () => {
      clearInterval(pollTimer);
      setIsPolling(false);
    };
  }, [autoStart, refresh, pollInterval]);

  return {
    status,
    isHealthy: status?.overall === 'HEALTHY',
    isLoading: isLoading || isPolling,
    error,
    providers,
    refresh,
  };
}

/**
 * Utility hook to get a specific provider status
 */
export function useLLMProviderStatus(provider: LLMProvider) {
  const { providers, isHealthy } = useLLMStatus({
    autoStart: true,
  });

  const providerStatus = providers[provider];

  return {
    isHealthy: providerStatus?.isHealthy ?? false,
    responseTime: providerStatus?.responseTime,
    availableModels: providerStatus?.availableModels ?? [],
    error: providerStatus?.errorMessage,
  };
}

export default useLLMStatus;
