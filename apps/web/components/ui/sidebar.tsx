'use client';

import { useState, useCallback, useEffect, useRef, memo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import {
  FolderOpen,
  Settings,
  LayoutDashboard,
  LogOut,
  ChevronRight,
  Menu,
  X,
  HelpCircle,
  ChevronsUpDown,
  Lock,
  CheckCircle,
  Loader2,
  Settings2,
  ScanSearch,
  PenLine,
  BookOpen,
  Compass,
  Code2,
  GitCompare,
  Wrench,
  Bot,
  Cpu,
  ShieldAlert,
  Sun,
  Moon,
  Monitor,
} from 'lucide-react';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useAuth } from '@/lib/hooks/use-auth';
import { useUIPreferencesStore } from '@/lib/stores/ui-preferences-store';
import { usePipelineStore } from '@/lib/stores/pipeline-store';
import type { StageState } from '@revamp/core';
import { cn } from '@/lib/utils';

// Stable empty array reference to avoid re-renders when not on pipeline page.
// Without this, `[] !== []` would cause the Sidebar to re-render on every
// pipeline store update even when not showing stages.
const EMPTY_STAGES: StageState[] = [];

// --- Navigation Config ---

interface NavItem {
  label: string;
  href: string;
  icon: typeof FolderOpen;
  match: string[];
  roles?: string[];
}

const navigationItems: NavItem[] = [
  {
    label: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
    match: ['/dashboard'],
  },
  {
    label: 'Projects',
    href: '/projects',
    icon: FolderOpen,
    match: ['/projects'],
  },
  {
    label: 'Agents',
    href: '/agents',
    icon: Bot,
    match: ['/agents'],
  },
  {
    label: 'BREE Engine',
    href: '/bree-engine',
    icon: Cpu,
    match: ['/bree-engine'],
  },
];

// --- Pipeline Stage Icons ---

const STAGE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  SCAN: Settings2,
  DECODE: ScanSearch,
  BLUEPRINT: PenLine,
  SPEC_LOCK: BookOpen,
  ARCHITECT: Compass,
  FORGE: Code2,
  SHADOW_RUN: GitCompare,
  EVOLVE: Wrench,
};

function StageStatusIndicator({ status }: { status: StageState['status'] }) {
  switch (status) {
    case 'completed':
    case 'approved':
      return <CheckCircle className="w-3 h-3 text-green-400" />;
    case 'generating':
    case 'validating':
      return <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />;
    case 'failed':
      return <div className="w-2 h-2 rounded-full bg-red-500" />;
    case 'locked':
      return <Lock className="w-3 h-3 text-slate-600" />;
    default:
      return <div className="w-2 h-2 rounded-full bg-slate-500" />;
  }
}

// --- NavLink ---

const NavLink = memo(function NavLink({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      className={cn(
        'flex items-center gap-3 rounded-lg text-sm font-medium transition-all duration-200',
        collapsed ? 'px-3 py-3 justify-center' : 'px-4 py-3',
        active
          ? 'bg-primary-600 text-white shadow-lg shadow-primary-600/20'
          : 'text-slate-300 hover:bg-slate-800/70 hover:text-white',
      )}
      title={collapsed ? item.label : undefined}
    >
      <Icon className="w-5 h-5 shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1">{item.label}</span>
          {active && <ChevronRight className="w-4 h-4" />}
        </>
      )}
    </Link>
  );
});

// --- Main Sidebar ---

export const Sidebar = memo(function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { logout } = useAuth();
  const user = useAuthStore((s) => s.user);
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const { sidebarCollapsed: collapsed, toggleSidebar } = useUIPreferencesStore();
  void ((v: boolean) => { if (v !== collapsed) toggleSidebar(); }); // kept for future use
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);

  useEffect(() => setMounted(true), []);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  // Pipeline state — only subscribe to pipeline store when on a project page
  // to avoid triggering heavy store hydration on unrelated pages.
  const pipelineMatch = pathname.match(/^\/projects\/([^/]+)\/pipeline/);
  const projectPageMatch = pathname.match(/^\/projects\/([^/]+)(\/settings)?$/);
  const isPipelinePage = !!pipelineMatch || !!projectPageMatch;
  const pipelineProjectId = pipelineMatch?.[1] ?? projectPageMatch?.[1] ?? null;

  // Only show stages if the store's project matches the current URL's project.
  // This prevents showing stale stages from a different project.
  const storeProjectId = usePipelineStore((s) => s.currentProjectId);
  const isMatchingProject = isPipelinePage && pipelineProjectId === storeProjectId;

  const stages = usePipelineStore((s) => isMatchingProject ? s.stages : EMPTY_STAGES);
  const activeStageIndex = usePipelineStore((s) => isMatchingProject ? s.activeStageIndex : 0);
  const setActiveStage = usePipelineStore((s) => s.setActiveStage);

  const isActive = useCallback(
    (matches: string[]) => matches.some((match) => pathname.startsWith(match)),
    [pathname],
  );

  const handleLogout = useCallback(async () => {
    setProfileMenuOpen(false);
    await logout();
  }, [logout]);

  // Close profile menu on click outside
  useEffect(() => {
    if (!profileMenuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setProfileMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [profileMenuOpen]);

  const visibleNavItems = navigationItems.filter((item) => {
    if (!item.roles) return true;
    return item.roles.includes(user?.role || '');
  });

  const userInitial = user?.name?.charAt(0)?.toUpperCase() || user?.email?.charAt(0)?.toUpperCase() || '?';

  const sidebarContent = (
    <aside
      className={cn(
        'h-screen bg-slate-900 dark:bg-slate-950 border-r border-slate-800 flex flex-col transition-all duration-300',
        collapsed ? 'w-[52px]' : 'w-64',
      )}
    >
      {/* Header: Toggle + Logo */}
      <div className={cn('flex items-center border-b border-slate-800 shrink-0', collapsed ? 'justify-center px-2 py-3.5' : 'gap-2.5 px-4 py-3.5')}>
        <button
          onClick={toggleSidebar}
          className="flex items-center justify-center w-8 h-8 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <Menu className="w-[18px] h-[18px]" />
        </button>
        {!collapsed && (
          <Link href="/projects" className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-bold text-slate-400 tracking-widest shrink-0">TAVANT</span>
            <span className="text-slate-600 text-sm">|</span>
            <div className="w-7 h-7 rounded-lg bg-primary-500 flex items-center justify-center shrink-0">
              <Code2 className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="text-[15px] font-bold text-white tracking-tight leading-none">AIgnite</span>
          </Link>
        )}
      </div>

      {/* Navigation */}
      <nav className={cn('py-4 space-y-1', collapsed ? 'px-2' : 'px-3')}>
        {visibleNavItems.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(item.match)}
            collapsed={collapsed}
          />
        ))}
      </nav>

      {/* Pipeline Stages — shown when on a project page with matching store */}
      {isPipelinePage && (stages.length > 0 || pipelineProjectId) && (
        <div className={cn('flex-1 overflow-y-auto border-t border-slate-800', collapsed ? 'px-2' : 'px-3')}>
          {/* Project Overview & Settings links */}
          {pipelineProjectId && (
            <div className="pt-2 pb-1 space-y-0.5">
              <Link
                href={`/projects/${pipelineProjectId}`}
                className={cn(
                  'flex items-center gap-2 rounded-lg text-[13px] font-medium transition-all duration-150 cursor-pointer',
                  collapsed ? 'px-2.5 py-2.5 justify-center' : 'px-3 py-2',
                  pathname === `/projects/${pipelineProjectId}`
                    ? 'bg-primary-600/20 text-primary-300'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white',
                )}
                title={collapsed ? 'Project Overview' : undefined}
              >
                <FolderOpen className="w-4 h-4 shrink-0 text-slate-400" />
                {!collapsed && <span className="flex-1 text-left truncate">Project Overview</span>}
              </Link>
              <Link
                href={`/projects/${pipelineProjectId}/settings`}
                className={cn(
                  'flex items-center gap-2 rounded-lg text-[13px] font-medium transition-all duration-150 cursor-pointer',
                  collapsed ? 'px-2.5 py-2.5 justify-center' : 'px-3 py-2',
                  pathname === `/projects/${pipelineProjectId}/settings`
                    ? 'bg-primary-600/20 text-primary-300'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white',
                )}
                title={collapsed ? 'Project Settings' : undefined}
              >
                <Settings className="w-4 h-4 shrink-0 text-slate-400" />
                {!collapsed && <span className="flex-1 text-left truncate">Project Settings</span>}
              </Link>
            </div>
          )}
          {!collapsed && (
            <div className="px-1 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Pipeline Stages
            </div>
          )}
          <div className="space-y-0.5 pb-2">
            {stages.map((stage, index) => {
              const isStageActive = index === activeStageIndex;
              const isClickable = stage.status !== 'locked';
              const Icon = STAGE_ICONS[stage.name] ?? ScanSearch;

              return (
                <button
                  key={stage.name}
                  onClick={() => {
                    if (!isClickable) return;
                    setActiveStage(index);
                    if (!pipelineMatch && pipelineProjectId) {
                      router.push(`/projects/${pipelineProjectId}/pipeline`);
                    }
                  }}
                  disabled={!isClickable}
                  title={collapsed ? `${stage.label} — ${stage.status}` : undefined}
                  className={cn(
                    'w-full flex items-center gap-2 rounded-lg text-[13px] transition-all duration-150',
                    collapsed ? 'px-2.5 py-2.5 justify-center' : 'px-3 py-2',
                    isStageActive
                      ? 'bg-primary-600/20 text-primary-300 font-medium'
                      : isClickable
                        ? 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-200'
                        : 'text-slate-600 cursor-not-allowed',
                  )}
                >
                  <Icon className={cn('w-4 h-4 shrink-0', isStageActive ? 'text-primary-400' : '')} />
                  {!collapsed && (
                    <>
                      <span className="flex-1 text-left truncate">{stage.label}</span>
                      <StageStatusIndicator status={stage.status} />
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Spacer when not on pipeline page */}
      {!isPipelinePage && <div className="flex-1" />}

      {/* User Section — claude.ai style with popover */}
      <div ref={profileMenuRef} className="relative">
        {/* Popover menu */}
        <div
          className={`absolute bottom-full left-2 right-2 mb-1.5 bg-slate-800 dark:bg-slate-900 rounded-xl border border-slate-700 shadow-lg z-50
            transition-all duration-200 ease-out origin-bottom
            ${profileMenuOpen
              ? 'opacity-100 scale-100 translate-y-0 pointer-events-auto'
              : 'opacity-0 scale-95 translate-y-1 pointer-events-none'
            }`}
        >
          {!collapsed && (
            <div className="px-4 py-3 border-b border-slate-700">
              <p className="text-[13px] text-slate-400 truncate">
                {user?.email || 'user@aignite.dev'}
              </p>
            </div>
          )}
          <div className="py-1.5">
            <Link
              href="/settings"
              onClick={() => setProfileMenuOpen(false)}
              className="w-full flex items-center gap-3 px-4 py-2 text-[13px] text-slate-300 hover:bg-slate-700/60 transition-colors"
            >
              <Settings className="w-4 h-4 text-slate-500" />
              <span className="flex-1 text-left">Settings</span>
            </Link>
            {user?.role === 'admin' && (
              <Link
                href="/dashboard"
                onClick={() => setProfileMenuOpen(false)}
                className="w-full flex items-center gap-3 px-4 py-2 text-[13px] text-slate-300 hover:bg-slate-700/60 transition-colors"
              >
                <ShieldAlert className="w-4 h-4 text-slate-500" />
                <span className="flex-1 text-left">Admin & Audit</span>
              </Link>
            )}
            <button className="w-full flex items-center gap-3 px-4 py-2 text-[13px] text-slate-300 hover:bg-slate-700/60 transition-colors">
              <HelpCircle className="w-4 h-4 text-slate-500" />
              <span className="flex-1 text-left">Get help</span>
            </button>
          </div>

          {/* Theme Switcher */}
          <div className="border-t border-slate-700 px-4 py-2.5">
            <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500 mb-2">Theme</p>
            <div className="flex gap-1 bg-slate-800 rounded-lg p-0.5">
              {([
                { value: 'light', icon: Sun, label: 'Light' },
                { value: 'dark', icon: Moon, label: 'Dark' },
                { value: 'system', icon: Monitor, label: 'System' },
              ] as const).map(({ value, icon: Icon, label }) => (
                <button
                  key={value}
                  onClick={() => setTheme(value)}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors',
                    (mounted ? theme === value : value === 'system')
                      ? 'bg-slate-700 text-slate-100 shadow-sm'
                      : 'text-slate-400 hover:text-slate-200',
                  )}
                >
                  <Icon className="w-3 h-3" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-slate-700 py-1.5">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 py-2 text-[13px] text-slate-300 hover:bg-slate-700/60 transition-colors"
            >
              <LogOut className="w-4 h-4 text-slate-500" />
              <span className="flex-1 text-left">Log out</span>
            </button>
          </div>
        </div>

        {/* Profile trigger bar */}
        <div className={cn('border-t border-slate-800', collapsed ? 'p-2' : 'p-2')}>
          <button
            onClick={() => setProfileMenuOpen(!profileMenuOpen)}
            className={cn(
              'w-full flex items-center rounded-xl transition-colors duration-150',
              profileMenuOpen
                ? 'bg-slate-800'
                : 'hover:bg-slate-800/70',
              collapsed ? 'justify-center p-2' : 'gap-2.5 px-2.5 py-2 text-left',
            )}
          >
            <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-slate-300 font-medium text-[13px] shrink-0">
              {userInitial}
            </div>
            {!collapsed && (
              <>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-slate-200 truncate leading-tight">
                    {user?.name || user?.email || 'User'}
                  </p>
                  <p className="text-[11px] text-slate-500 truncate capitalize leading-tight mt-0.5">
                    {user?.role || 'Free'}
                  </p>
                </div>
                <ChevronsUpDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              </>
            )}
          </button>
        </div>
      </div>
    </aside>
  );

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-4 left-4 z-40 p-2 bg-slate-900 text-white rounded-lg shadow-lg"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Desktop sidebar */}
      <div className="hidden lg:block">{sidebarContent}</div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 lg:hidden">
            <div className="relative">
              {sidebarContent}
              <button
                onClick={() => setMobileOpen(false)}
                className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-white rounded"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
});
