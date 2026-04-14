'use client';

import { ThemeProvider } from 'next-themes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { setApiClient, setSessionStorage, setPersistStorage } from '@revamp/core';
import { apiClient } from '@/lib/api-client';

// ─── Platform Bridge (Multica pattern) ──────────────────────────
// @revamp/core defines interfaces, apps/web provides implementations.

// API client: axios with cookies + token interceptor
setApiClient(apiClient);

// Storage adapters: browser sessionStorage + localStorage
if (typeof window !== 'undefined') {
  setSessionStorage(window.sessionStorage);
  setPersistStorage(window.localStorage);
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
