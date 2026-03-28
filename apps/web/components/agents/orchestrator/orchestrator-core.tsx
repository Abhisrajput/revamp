'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { AgentOrchestratorState, OrchestratorState } from '@/lib/hooks/use-orchestrator';

// ─── DEPARTMENT CONFIG ──────────────────────────────────────────

const DEPT_CONFIG: Record<string, { borderClass: string; dotColor: string; labelColor: string }> = {
  discovery: { borderClass: 'border-purple-500/30', dotColor: '#a855f7', labelColor: 'rgb(168,85,247)' },
  execution: { borderClass: 'border-blue-500/30', dotColor: '#3b82f6', labelColor: 'rgb(59,130,246)' },
  qa: { borderClass: 'border-emerald-500/30', dotColor: '#10b981', labelColor: 'rgb(16,185,129)' },
  pm: { borderClass: 'border-amber-500/30', dotColor: '#f59e0b', labelColor: 'rgb(245,158,11)' },
};

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-green-400',
  working: 'bg-blue-400',
  paused: 'bg-amber-400',
  disabled: 'bg-slate-500',
};

interface OrchestratorCoreProps {
  agents: AgentOrchestratorState[];
  orchestratorState: OrchestratorState;
}

/**
 * Animated orchestrator core visualization.
 * Concentric orbit rings per department with agent dots.
 */
export function OrchestratorCore({ agents, orchestratorState }: OrchestratorCoreProps) {
  const isRunning = orchestratorState === 'running';

  const departments = useMemo(() => {
    const depts = ['discovery', 'execution', 'qa', 'pm'];
    return depts.map((dept, idx) => ({
      name: dept,
      agents: agents.filter((a) => a.department === dept),
      ringIndex: idx,
      config: DEPT_CONFIG[dept],
    }));
  }, [agents]);

  return (
    <div className="relative w-full aspect-square max-w-[480px] mx-auto">
      {/* Radial background glow */}
      <div
        className={cn(
          'absolute inset-0 rounded-full transition-opacity duration-1000',
          isRunning ? 'opacity-100' : 'opacity-30',
        )}
        style={{
          background: 'radial-gradient(circle, rgba(79,133,104,0.15) 0%, transparent 70%)',
        }}
      />

      {/* Orbit rings */}
      {departments.map((dept, idx) => {
        const size = 40 + idx * 15; // 40%, 55%, 70%, 85%
        const duration = 30 + idx * 12; // slower for outer rings

        return (
          <div
            key={dept.name}
            className={cn('absolute rounded-full border', dept.config.borderClass)}
            style={{
              width: `${size}%`,
              height: `${size}%`,
              top: `${(100 - size) / 2}%`,
              left: `${(100 - size) / 2}%`,
              animation: isRunning ? `orchestrator-spin ${duration}s linear infinite` : 'none',
            }}
          >
            {/* Agent dots on this ring */}
            {dept.agents.map((agent, agentIdx) => {
              const angle = (360 / Math.max(dept.agents.length, 1)) * agentIdx;
              // Counter-rotate so tooltips stay upright
              const counterStyle = isRunning
                ? { animation: `orchestrator-spin ${duration}s linear infinite reverse` }
                : {};

              return (
                <div
                  key={agent.id}
                  className="absolute"
                  style={{
                    top: '50%',
                    left: '50%',
                    transform: `rotate(${angle}deg) translateY(-50%)`,
                    width: '100%',
                    height: 0,
                    transformOrigin: '0 0',
                  }}
                >
                  {/* Position dot at edge of ring */}
                  <div
                    className="absolute"
                    style={{ right: -6, top: -6 }}
                  >
                    <div className="group relative" style={counterStyle}>
                      <div
                        className={cn(
                          'w-3 h-3 rounded-full shadow-lg transition-all',
                          STATUS_DOT[agent.status] || 'bg-slate-500',
                          agent.status === 'working' && 'ring-2 ring-blue-400/50 animate-pulse',
                        )}
                      />
                      {/* Tooltip */}
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-slate-900 text-white text-[10px] rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                        {agent.name}
                        <span className="block text-slate-400 text-[9px]">{agent.status}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {/* Center core */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className={cn(
            'w-20 h-20 rounded-full flex items-center justify-center transition-all duration-500',
            isRunning
              ? 'bg-primary-600/20 shadow-[0_0_40px_rgba(79,133,104,0.4)]'
              : orchestratorState === 'paused'
                ? 'bg-amber-600/20 shadow-[0_0_20px_rgba(245,158,11,0.2)]'
                : 'bg-slate-700/40',
          )}
        >
          <div
            className={cn(
              'w-12 h-12 rounded-full flex items-center justify-center text-xs font-bold tracking-wider',
              isRunning
                ? 'bg-primary-600/30 text-primary-200 animate-pulse'
                : orchestratorState === 'paused'
                  ? 'bg-amber-600/30 text-amber-200'
                  : 'bg-slate-600/30 text-slate-400',
            )}
          >
            {isRunning ? 'LIVE' : orchestratorState === 'paused' ? 'HOLD' : 'OFF'}
          </div>
        </div>
      </div>

      {/* Ring labels */}
      {departments.map((dept, idx) => {
        const size = 40 + idx * 15;
        return (
          <div
            key={`label-${dept.name}`}
            className="absolute text-[9px] font-medium uppercase tracking-wider pointer-events-none"
            style={{
              top: `${(100 - size) / 2 - 2.5}%`,
              left: '50%',
              transform: 'translateX(-50%)',
              color: dept.config.labelColor,
              opacity: 0.6,
            }}
          >
            {dept.name}
          </div>
        );
      })}

      {/* Keyframe for orbit rotation */}
      <style>{`
        @keyframes orchestrator-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
