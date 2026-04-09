'use client';

import { memo } from 'react';
import { cn } from '@/lib/utils';
import { Database, Server, Cpu, HardDrive, CheckCircle, XCircle } from 'lucide-react';

interface ServiceStatus {
  status: string;
  latency_ms?: number;
  providers?: Record<string, string>;
}

interface ServiceHealthGridProps {
  services: Record<string, ServiceStatus>;
}

const SERVICE_META: Record<string, { label: string; icon: React.ElementType; description: string }> = {
  database: { label: 'PostgreSQL', icon: Database, description: 'Primary data store' },
  redis: { label: 'Redis', icon: Server, description: 'Cache & job queue' },
  llm_orchestrator: { label: 'LLM Orchestrator', icon: Cpu, description: 'AI model routing' },
  s3_storage: { label: 'MinIO / S3', icon: HardDrive, description: 'Artifact storage' },
};

export const ServiceHealthGrid = memo(function ServiceHealthGrid({ services }: ServiceHealthGridProps) {
  const entries = Object.entries(services);
  const allHealthy = entries.every(([, s]) => s.status === 'ok');

  return (
    <div className="space-y-3">
      {/* Overall health banner */}
      <div className={cn(
        'flex items-center gap-3 px-4 py-3 rounded-lg border',
        allHealthy
          ? 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/40'
          : 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800/40',
      )}>
        <div className="relative">
          {allHealthy ? (
            <CheckCircle className="w-5 h-5 text-emerald-500" />
          ) : (
            <XCircle className="w-5 h-5 text-amber-500" />
          )}
          {allHealthy && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-400 rounded-full">
              <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-75" />
            </span>
          )}
        </div>
        <div>
          <p className={cn('text-sm font-medium', allHealthy ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300')}>
            {allHealthy ? 'All systems operational' : 'Some services degraded'}
          </p>
          <p className="text-[10px] text-slate-400">{entries.length} services monitored</p>
        </div>
      </div>

      {/* Service cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {entries.map(([name, service]) => {
          const meta = SERVICE_META[name] || { label: name, icon: Server, description: '' };
          const Icon = meta.icon;
          const isOk = service.status === 'ok';

          return (
            <div
              key={name}
              className={cn(
                'rounded-xl border p-4 transition-all duration-300',
                isOk
                  ? 'border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-800/80'
                  : 'border-red-200 dark:border-red-800/40 bg-red-50/50 dark:bg-red-950/10',
              )}
            >
              <div className="flex items-center justify-between mb-3">
                <Icon className={cn('w-4.5 h-4.5', isOk ? 'text-slate-400' : 'text-red-400')} />
                <div className="relative flex items-center gap-1">
                  <span className={cn(
                    'w-2 h-2 rounded-full',
                    isOk ? 'bg-emerald-400' : 'bg-red-400',
                  )}>
                    {isOk && <span className="absolute inset-0 w-2 h-2 rounded-full bg-emerald-400 animate-ping opacity-50" />}
                  </span>
                </div>
              </div>
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{meta.label}</p>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">{meta.description}</p>
              {service.latency_ms !== undefined && (
                <p className="text-[10px] font-mono text-slate-400 mt-1.5">{service.latency_ms}ms latency</p>
              )}
              {service.providers && Object.keys(service.providers).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {Object.entries(service.providers).map(([p, status]) => (
                    <span key={p} className={cn(
                      'text-[9px] px-1.5 py-0.5 rounded-full',
                      status === 'ok' || status === 'available'
                        ? 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                        : 'bg-red-100 dark:bg-red-900/20 text-red-600 dark:text-red-400',
                    )}>
                      {p}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
