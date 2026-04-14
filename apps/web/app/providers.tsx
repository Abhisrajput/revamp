'use client';

import { ThemeProvider } from 'next-themes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { setApiClient, setSessionStorage, setPersistStorage, setNotificationAdapter } from '@revamp/core';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';

// ─── Platform Bridge (Multica pattern) ──────────────────────────
// @revamp/core defines interfaces, apps/web provides implementations.

// API client: axios with cookies + token interceptor
setApiClient(apiClient);

// Storage adapters: browser sessionStorage + localStorage
if (typeof window !== 'undefined') {
  setSessionStorage(window.sessionStorage);
  setPersistStorage(window.localStorage);
}

// Notification adapter: sonner toasts + notification store
setNotificationAdapter({
  success: (title, message, metadata) => {
    toast.success(title, { description: message, duration: 5000 });
    try {
      const { useNotificationStore } = require('@/lib/stores/notification-store');
      useNotificationStore.getState().addNotification({ type: 'success', title, message, metadata });
    } catch { /* non-fatal */ }
  },
  error: (title, message, metadata) => {
    toast.error(title, { description: message, duration: 8000 });
    try {
      const { useNotificationStore } = require('@/lib/stores/notification-store');
      useNotificationStore.getState().addNotification({ type: 'error', title, message, metadata });
    } catch { /* non-fatal */ }
  },
  info: (title, message) => {
    toast.info(title, { description: message, duration: 3000 });
  },
});

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
