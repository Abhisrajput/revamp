"use client";

import { useQuery } from "@tanstack/react-query";

interface User {
  id: string;
  email: string;
  name?: string;
  role: "admin" | "architect" | "developer" | "sme";
}

export function useAuth() {
  const q = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async (): Promise<{ user: User | null }> => {
      // Use native fetch so this works without the injected axios client.
      // Credentials (iron-session cookie) are sent automatically.
      const r = await fetch("/api/auth/me", { credentials: "include" });
      if (!r.ok) return { user: null };
      return r.json() as Promise<{ user: User | null }>;
    },
    staleTime: 5 * 60_000,
  });

  return {
    user: q.data?.user ?? null,
    isLoading: q.isLoading,
    login: () => {
      if (typeof window !== "undefined") {
        window.location.href = "/auth/login";
      }
    },
    logout: () => {
      if (typeof window !== "undefined") {
        window.location.href = "/auth/logout";
      }
    },
    // Legacy stub — credential-based login is now handled by Keycloak OIDC.
    // Consumers that still call this will get a loud runtime error prompting migration.
    loginWithCredentials: (_email: string, _password: string): Promise<{ success: boolean; error?: string }> => {
      throw new Error(
        "loginWithCredentials() removed: use Keycloak OIDC via /auth/login instead",
      );
    },
  };
}
