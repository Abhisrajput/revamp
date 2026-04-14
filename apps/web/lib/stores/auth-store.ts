import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { useEffect, useState } from 'react';

export interface User {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  /** Convenience full name — may be provided directly by API or derived from first/last */
  name?: string | null;
  role: string;
  organization_id: string | null;
}

interface AuthState {
  token: string | null;
  user: User | null;
  isAuthenticated: boolean;
  setAuth: (token: string, user: User) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      isAuthenticated: false,

      setAuth: (token, user) => {
        // Token is now set as HttpOnly cookie by the API server.
        // We keep it in Zustand state only for backward compatibility
        // (e.g., SSE fetch headers) — it is NOT stored in localStorage.
        // The previous localStorage.setItem('auth_token') has been removed
        // to prevent XSS token theft.
        set({ token, user, isAuthenticated: true });
      },

      clearAuth: () => {
        // HttpOnly cookie is cleared by the API on logout.
        // We clear client-side state here.
        if (typeof window !== 'undefined') {
          localStorage.removeItem('auth_token'); // clean up legacy storage
        }
        set({ token: null, user: null, isAuthenticated: false });
      },
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' ? localStorage : ({} as Storage),
      ),
      // Only persist auth status and user profile — NOT the token.
      // Token is kept in Zustand memory for SSE Bearer headers but never
      // written to localStorage (prevents XSS token theft).
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
);

/**
 * Returns true once the Zustand persist layer has rehydrated from localStorage.
 * Use this to gate redirects so they don't fire before hydration completes.
 */
export function useAuthHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // The persist middleware exposes a `_hasHydrated` flag after onFinishHydration
    const unsubFinish = useAuthStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });

    // If already hydrated (e.g. store was created before this hook mounted)
    if (useAuthStore.persist.hasHydrated()) {
      setHydrated(true);
    }

    return () => {
      unsubFinish();
    };
  }, []);

  return hydrated;
}
