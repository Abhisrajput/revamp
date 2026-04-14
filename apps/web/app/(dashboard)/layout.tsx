'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore, useAuthHydrated } from '@revamp/core';
import { Sidebar } from '@/components/ui/sidebar';
import { TopBar } from '@/components/layout/top-bar';
import { AgentNotifications } from '@/components/agents/agent-notification';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hydrated = useAuthHydrated();

  // Pipeline page uses its own full-bleed layout (MissionControlLayout)
  const isFullBleed = pathname?.includes('/pipeline');

  // Public routes that don't require authentication (read-only tools)
  const isPublicRoute = pathname?.startsWith('/bree-engine');

  useEffect(() => {
    // Redirect to login only after hydration confirms no auth.
    // Skip for public routes like BREE Engine dashboard.
    if (hydrated && !isAuthenticated && !isPublicRoute) {
      router.replace('/login');
    }
  }, [hydrated, isAuthenticated, isPublicRoute, router]);

  // Hide content if hydration finished and user is not authenticated (except public routes)
  if (hydrated && !isAuthenticated && !isPublicRoute) {
    return null;
  }

  return (
    <div className="flex h-screen bg-white dark:bg-slate-950">
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Top Bar */}
        <TopBar />

        {/* Page Content */}
        <main className={isFullBleed
          ? "flex-1 overflow-hidden bg-slate-50 dark:bg-slate-900"
          : "flex-1 overflow-auto bg-slate-50 dark:bg-slate-900"
        }>
          {isFullBleed ? children : (
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
              {children}
            </div>
          )}
        </main>
      </div>

      {/* Agent Event Notifications */}
      <AgentNotifications />
    </div>
  );
}
