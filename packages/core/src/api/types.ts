/**
 * API Client interface — platform-agnostic.
 *
 * apps/web provides the concrete implementation (axios + cookies).
 * apps/vscode could provide a different one (fetch + token header).
 *
 * Multica pattern: CoreProvider injects the concrete client at boot.
 */

export interface ApiClient {
  get<T = any>(url: string, config?: RequestConfig): Promise<ApiResponse<T>>;
  post<T = any>(url: string, data?: any, config?: RequestConfig): Promise<ApiResponse<T>>;
  put<T = any>(url: string, data?: any, config?: RequestConfig): Promise<ApiResponse<T>>;
  patch<T = any>(url: string, data?: any, config?: RequestConfig): Promise<ApiResponse<T>>;
  delete<T = any>(url: string, config?: RequestConfig): Promise<ApiResponse<T>>;
  /** Base URL for raw fetch calls (SSE endpoints, file uploads) */
  getBaseUrl?: () => string;
}

export interface RequestConfig {
  headers?: Record<string, string>;
  params?: Record<string, any>;
  signal?: AbortSignal;
}

export interface ApiResponse<T = any> {
  data: T;
  status: number;
}

// ─── Global singleton (set by platform provider) ────────────────

let _apiClient: ApiClient | null = null;

export function setApiClient(client: ApiClient) {
  _apiClient = client;
}

// No-op client for SSR — returns empty data, never throws
const SSR_NOOP_CLIENT: ApiClient = {
  get: async () => ({ data: null, status: 200 }),
  post: async () => ({ data: null, status: 200 }),
  put: async () => ({ data: null, status: 200 }),
  patch: async () => ({ data: null, status: 200 }),
  delete: async () => ({ data: null, status: 200 }),
};

export function getApiClient(): ApiClient {
  if (!_apiClient) return SSR_NOOP_CLIENT;
  return _apiClient;
}
