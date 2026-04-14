'use client';

import { ThemeProvider } from 'next-themes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { setApiClient, setSessionStorage, setPersistStorage, setNotificationAdapter } from '@revamp/core';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';

// ─── Platform Bridge (Multica pattern) ──────────────────────────
// @revamp/core defines interfaces, apps/web provides implementations.

// All platform bridge registrations must be client-side only.
// SSR renders the shell; client hydration initializes the adapters.
if (typeof window !== 'undefined') {
  // Storage adapters first (stores depend on these during creation)
  setSessionStorage(window.sessionStorage);
  setPersistStorage(window.localStorage);
  // API client
  setApiClient(apiClient);
}

// Notification adapter: sonner toasts
// Registered lazily to avoid require() issues during SSR
if (typeof window !== 'undefined') {
  setNotificationAdapter({
    success: (title, message) => {
      toast.success(title, { description: message, duration: 5000 });
    },
    error: (title, message) => {
      toast.error(title, { description: message, duration: 8000 });
    },
    info: (title, message) => {
      toast.info(title, { description: message, duration: 3000 });
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000,
            gcTime: 10 * 60 * 1000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
          mutations: {
            retry: 1,
          },
        },
      })
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </ThemeProvider>
  );
}
