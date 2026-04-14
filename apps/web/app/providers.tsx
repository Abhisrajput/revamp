'use client';

import { ThemeProvider } from 'next-themes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
// Import directly from specific files — NOT from @revamp/core barrel.
// The barrel triggers Zustand store creation (auth, pipeline, config, activity)
// at import time, which crashes during SSR because storage adapters aren't registered yet.
import { setApiClient } from '@revamp/core/api/types';
import { setSessionStorage, setPersistStorage } from '@revamp/core/api/storage';
import { setNotificationAdapter } from '@revamp/core/api/notifications';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';

// ─── Platform Bridge ──────────────────────────────────────────────

// API client registered unconditionally (axios works on server + client)
setApiClient(apiClient);

// Storage + notifications are browser-only
if (typeof window !== 'undefined') {
  setSessionStorage(window.sessionStorage);
  setPersistStorage(window.localStorage);

  setNotificationAdapter({
    success: (title, message) => toast.success(title, { description: message, duration: 5000 }),
    error: (title, message) => toast.error(title, { description: message, duration: 8000 }),
    info: (title, message) => toast.info(title, { description: message, duration: 3000 }),
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
