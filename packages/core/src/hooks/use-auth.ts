import { useCallback } from 'react';
import { getApiClient } from '../api/types';
import { useAuthStore } from '../stores/auth-store';

export function useAuth() {
  const { user, isAuthenticated, setAuth, clearAuth } = useAuthStore();

  const login = useCallback(async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const response = await getApiClient().post('/auth/login', { email, password });
      const { token, user: userData } = response.data;
      if (token && userData) {
        setAuth(token, userData);
        return { success: true };
      }
      return { success: false, error: 'No token returned from server' };
    } catch (err: any) {
      const msg =
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        err?.message ||
        `HTTP ${err?.response?.status ?? 'unknown'}`;
      return { success: false, error: msg };
    }
  }, [setAuth]);

  const logout = useCallback(() => {
    clearAuth();
  }, [clearAuth]);

  return { login, logout, user, isAuthenticated };
}
