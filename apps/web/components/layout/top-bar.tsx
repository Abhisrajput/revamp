'use client';

import { memo, useCallback } from 'react';
import { useTheme } from 'next-themes';
import { Moon, Sun, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/lib/stores/auth-store';
import { NotificationBell } from '@/components/layout/notification-bell';

export const TopBar = memo(function TopBar() {
  const { theme, setTheme } = useTheme();
  const user = useAuthStore((s) => s.user);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  const userInitial = user?.name?.charAt(0)?.toUpperCase() || user?.email?.charAt(0)?.toUpperCase() || '?';

  return (
    <header className="h-14 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 flex items-center justify-between px-4 lg:px-6 shrink-0">
      {/* Left: Title + Search placeholder */}
      <div className="flex items-center gap-4 min-w-0">
        {/* Mobile spacer for sidebar toggle */}
        <div className="w-8 lg:hidden" />
        <h2 className="text-sm text-slate-500 dark:text-slate-400 truncate hidden sm:block">
          Welcome back, <span className="text-slate-700 dark:text-slate-200 font-medium">{user?.name || 'User'}</span>
        </h2>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1 sm:gap-2">
        {/* Global search trigger (future) */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          title="Search (coming soon)"
          disabled
        >
          <Search className="w-4 h-4" />
        </Button>

        {/* Notifications */}
        <NotificationBell />

        {/* Theme Toggle */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? (
            <Sun className="w-4 h-4" />
          ) : (
            <Moon className="w-4 h-4" />
          )}
        </Button>

        {/* User Avatar */}
        <div className="flex items-center gap-2 ml-1 pl-2 border-l border-slate-200 dark:border-slate-700">
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white font-semibold text-xs shrink-0">
            {userInitial}
          </div>
          <span className="text-sm text-slate-700 dark:text-slate-300 hidden sm:block">
            {user?.name ? user.name.split(' ')[0] : 'User'}
          </span>
        </div>
      </div>
    </header>
  );
});
