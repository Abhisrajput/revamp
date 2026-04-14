import axios from 'axios';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

export const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,
});

// Attach Bearer token as fallback for SSE fetch (cookies are primary auth).
// Lazy-import useAuthStore to avoid triggering @revamp/core barrel import
// during SSR (which would create all stores before storage adapters are registered).
apiClient.interceptors.request.use((config) => {
  if (typeof window === 'undefined') return config;
  try {
    const { useAuthStore } = require('@revamp/core');
    const token = useAuthStore.getState().token;
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // Store not available — cookie handles auth
  }
  return config;
});

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

// Extend with getBaseUrl for SSE/fetch endpoints
(apiClient as any).getBaseUrl = () => BASE_URL;
