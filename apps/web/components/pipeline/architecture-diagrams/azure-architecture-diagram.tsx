'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { ArchitectureDiagramProps, CloudService } from './types';

const DEFAULT_AZURE_SERVICES: CloudService[] = [
  { id: 'frontdoor', name: 'Front Door', type: 'cdn', connections: ['apim'] },
  { id: 'apim', name: 'API Management', type: 'api-gateway', connections: ['appservice', 'aks'] },
  { id: 'appservice', name: 'App Service', type: 'compute', connections: ['sqldb', 'servicebus'] },
  { id: 'aks', name: 'AKS', type: 'container', connections: ['sqldb', 'redis'] },
  { id: 'functions', name: 'Functions', type: 'serverless', connections: ['cosmosdb', 'servicebus'] },
  { id: 'sqldb', name: 'SQL Database', type: 'database', connections: ['blob'] },
  { id: 'cosmosdb', name: 'Cosmos DB', type: 'nosql', connections: [] },
  { id: 'servicebus', name: 'Service Bus', type: 'queue', connections: ['functions'] },
  { id: 'redis', name: 'Azure Cache', type: 'cache', connections: [] },
  { id: 'blob', name: 'Blob Storage', type: 'storage', connections: [] },
];

const POSITION_MAP: Record<string, { col: number; row: number }> = {
  cdn:          { col: 0, row: 0 },
  'api-gateway':{ col: 1, row: 0 },
  compute:      { col: 2, row: 0 },
  container:    { col: 2, row: 1 },
  serverless:   { col: 3, row: 1 },
  database:     { col: 3, row: 0 },
  nosql:        { col: 4, row: 1 },
  queue:        { col: 1, row: 1 },
  cache:        { col: 4, row: 0 },
  storage:      { col: 5, row: 0 },
};

const SERVICE_COLORS: Record<string, string> = {
  cdn: '#0078D4',
  'api-gateway': '#0078D4',
  compute: '#0078D4',
  container: '#326CE5',
  serverless: '#F7B93E',
  database: '#0078D4',
  nosql: '#0078D4',
  queue: '#A855F7',
  cache: '#EF4444',
  storage: '#0078D4',
};

function getPosition(type: string): { x: number; y: number } {
  const pos = POSITION_MAP[type] || { col: 3, row: 2 };
  return { x: 40 + pos.col * 120, y: 40 + pos.row * 110 };
}

export function AzureArchitectureDiagram({
  services: inputServices,
  className,
  title = 'Azure Target Architecture',
}: ArchitectureDiagramProps) {
  const services = inputServices.length > 0 ? inputServices : DEFAULT_AZURE_SERVICES;

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
        <div className="w-2 h-2 rounded-full bg-[#0078D4]" />
        <span className="text-xs font-medium text-slate-400">{title}</span>
        <span className="ml-auto text-[10px] text-slate-600">Azure</span>
      </div>
      <svg viewBox="0 0 780 280" className="w-full" style={{ minHeight: 200 }}>
        <defs>
          <marker id="azure-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
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
            markerEnd="url(#azure-arrow)"
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
              {/* Azure diamond icon */}
              <polygon
                points={`${svc.pos.x + 15},${svc.pos.y + 16} ${svc.pos.x + 19},${svc.pos.y + 11} ${svc.pos.x + 23},${svc.pos.y + 16} ${svc.pos.x + 19},${svc.pos.y + 21}`}
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
