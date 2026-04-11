import axios from 'axios';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787';

export const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  // Send HttpOnly cookies with every request (JWT auth)
  withCredentials: true,
});

// Attach Bearer token from Zustand store as fallback (for SSE fetch which
// can't rely on cookies in all browsers). The primary auth path is now
// the HttpOnly cookie set by the API server.
apiClient.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    // Try Zustand store first (in-memory, not localStorage)
    try {
      const { useAuthStore } = require('@/lib/stores/auth-store');
      const token = useAuthStore.getState().token;
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    } catch {
      // Store not available during SSR — cookie handles auth
    }
  }
  return config;
});

// Handle 401 — clear state and redirect to login
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      // Avoid redirect loops on the login page
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);
