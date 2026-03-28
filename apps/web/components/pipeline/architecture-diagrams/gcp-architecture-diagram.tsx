'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { ArchitectureDiagramProps, CloudService } from './types';

const DEFAULT_GCP_SERVICES: CloudService[] = [
  { id: 'dns', name: 'Cloud DNS', type: 'dns', connections: ['cdn'] },
  { id: 'cdn', name: 'Cloud CDN', type: 'cdn', connections: ['lb'] },
  { id: 'lb', name: 'Load Balancer', type: 'load-balancer', connections: ['run', 'gke'] },
  { id: 'run', name: 'Cloud Run', type: 'compute', connections: ['sql', 'pubsub'] },
  { id: 'gke', name: 'GKE', type: 'container', connections: ['sql', 'memorystore'] },
  { id: 'sql', name: 'Cloud SQL', type: 'database', connections: ['gcs'] },
  { id: 'firestore', name: 'Firestore', type: 'nosql', connections: [] },
  { id: 'pubsub', name: 'Pub/Sub', type: 'queue', connections: ['run'] },
  { id: 'memorystore', name: 'Memorystore', type: 'cache', connections: [] },
  { id: 'gcs', name: 'Cloud Storage', type: 'storage', connections: [] },
];

const POSITION_MAP: Record<string, { col: number; row: number }> = {
  dns:            { col: 0, row: 0 },
  cdn:            { col: 1, row: 0 },
  'load-balancer':{ col: 2, row: 0 },
  compute:        { col: 3, row: 0 },
  container:      { col: 3, row: 1 },
  database:       { col: 4, row: 1 },
  nosql:          { col: 4, row: 0 },
  queue:          { col: 2, row: 1 },
  cache:          { col: 5, row: 1 },
  storage:        { col: 5, row: 0 },
};

const SERVICE_COLORS: Record<string, string> = {
  dns: '#8B5CF6',
  cdn: '#F59E0B',
  'load-balancer': '#3B82F6',
  compute: '#4285F4',
  container: '#4285F4',
  database: '#34A853',
  nosql: '#FBBC05',
  queue: '#EA4335',
  cache: '#EA4335',
  storage: '#34A853',
};

function getPosition(type: string): { x: number; y: number } {
  const pos = POSITION_MAP[type] || { col: 3, row: 2 };
  return { x: 40 + pos.col * 120, y: 40 + pos.row * 110 };
}

export function GcpArchitectureDiagram({
  services: inputServices,
  className,
  title = 'GCP Target Architecture',
}: ArchitectureDiagramProps) {
  const services = inputServices.length > 0 ? inputServices : DEFAULT_GCP_SERVICES;

  const positionedServices = useMemo(() => {
    return services.map((svc) => ({
      ...svc,
      pos: getPosition(svc.type),
    }));
  }, [services]);

  const connections = useMemo(() => {
    const lines: { x1: number; y1: number; x2: number; y2: number; key: string }[] = [];
    const svcMap = new Map(positionedServices.map((s) => [s.id, s]));

    for (const svc of positionedServices) {
      for (const targetId of svc.connections || []) {
        const target = svcMap.get(targetId);
        if (target) {
          lines.push({
            x1: svc.pos.x + 50,
            y1: svc.pos.y + 25,
            x2: target.pos.x + 50,
            y2: target.pos.y + 25,
            key: `${svc.id}-${targetId}`,
          });
        }
      }
    }
    return lines;
  }, [positionedServices]);

  return (
    <div className={cn('rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-950 overflow-hidden', className)}>
      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-800">
        <div className="w-2 h-2 rounded-full bg-blue-500" />
        <span className="text-xs font-medium text-slate-400">{title}</span>
        <span className="ml-auto text-[10px] text-slate-600">GCP</span>
      </div>
      <svg viewBox="0 0 780 280" className="w-full" style={{ minHeight: 200 }}>
        <defs>
          <marker id="gcp-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#475569" />
          </marker>
        </defs>

        {connections.map((line) => (
          <line
            key={line.key}
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke="#334155"
            strokeWidth="1.5"
            strokeDasharray="4 3"
            markerEnd="url(#gcp-arrow)"
          />
        ))}

        {positionedServices.map((svc) => {
          const color = SERVICE_COLORS[svc.type] || '#6B7280';
          return (
            <g key={svc.id}>
              <rect
                x={svc.pos.x}
                y={svc.pos.y}
                width={100}
                height={50}
                rx={6}
                fill="#1E293B"
                stroke={color}
                strokeWidth={1.5}
              />
              {/* GCP hexagon icon */}
              <polygon
                points={`${svc.pos.x + 15},${svc.pos.y + 13} ${svc.pos.x + 19},${svc.pos.y + 10} ${svc.pos.x + 23},${svc.pos.y + 13} ${svc.pos.x + 23},${svc.pos.y + 19} ${svc.pos.x + 19},${svc.pos.y + 22} ${svc.pos.x + 15},${svc.pos.y + 19}`}
                fill={color}
                opacity={0.8}
              />
              <text
                x={svc.pos.x + 50}
                y={svc.pos.y + 21}
                textAnchor="middle"
                fill="#E2E8F0"
                fontSize={10}
                fontWeight={600}
              >
                {svc.name}
              </text>
              {svc.description && (
                <text
                  x={svc.pos.x + 50}
                  y={svc.pos.y + 38}
                  textAnchor="middle"
                  fill="#94A3B8"
                  fontSize={8}
                >
                  {svc.description}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
