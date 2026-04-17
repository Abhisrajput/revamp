import axios from 'axios';

// All requests go through the Next.js /api/fastify proxy, which attaches the
// Keycloak Bearer token server-side. The browser never sees the token.
// FASTIFY_INTERNAL_URL is server-only (no NEXT_PUBLIC_ prefix).
const PROXY_BASE = '/api/fastify';

export const apiClient = axios.create({
  baseURL: PROXY_BASE,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // send iron-session cookie on every request
});

// No request interceptor needed — the /api/fastify proxy attaches the Bearer server-side.

// Handle 401 — redirect to login
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

// getBaseUrl returns the proxy prefix so fetch() call sites in @revamp/core
// also route through /api/fastify rather than hitting Fastify directly.
(apiClient as any).getBaseUrl = () => PROXY_BASE;
