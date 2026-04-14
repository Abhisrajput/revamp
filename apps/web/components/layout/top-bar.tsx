'use client';

import { memo } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@revamp/ui/components/button';
import { useAuthStore } from '@revamp/core/stores/auth-store';
import { useWSConnected } from '@revamp/core/hooks/use-ws';
import { NotificationBell } from '@/components/layout/notification-bell';

export const TopBar = memo(function TopBar() {
  const user = useAuthStore((s) => s.user);
  const wsConnected = useWSConnected();

  return (
    <header className="h-14 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 flex items-center justify-between px-4 lg:px-6 shrink-0">
      {/* Left: Welcome */}
      <div className="flex items-center gap-3 min-w-0">
        <h2 className="text-sm text-slate-500 dark:text-slate-400 truncate hidden sm:block">
          Welcome back, <span className="text-slate-700 dark:text-slate-200 font-medium">{user?.name || 'User'}</span>
        </h2>
      </div>

      {/* Right: Search + Notifications + WS indicator */}
      <div className="flex items-center gap-1 sm:gap-2">
        <span
          className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`}
          title={wsConnected ? 'Connected' : 'Disconnected — reconnecting...'}
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          title="Search (coming soon)"
          disabled
        >
          <Search className="w-4 h-4" />
        </Button>
        <NotificationBell />
      </div>
    </header>
  );
});
