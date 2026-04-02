'use client';

import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import {
  Brain, Hammer, Shield, FileText, Crown, Merge,
  Bot, CheckCheck, Lightbulb, AlertTriangle,
} from 'lucide-react';
import type { AgentOrchestratorState, OrchestratorState } from '@/lib/hooks/use-orchestrator';

const DEPT_ICONS: Record<string, { icon: typeof Brain; color: string }> = {
  discovery: { icon: Brain, color: '#a855f7' },
  execution: { icon: Hammer, color: '#3b82f6' },
  qa: { icon: Shield, color: '#10b981' },
  pm: { icon: FileText, color: '#f59e0b' },
};

const ROLE_ICONS: Record<string, typeof Brain> = {
  director: Crown, lead: Merge, specialist: Bot,
};

interface Neuron {
  id: string; name: string; role: string; dept: string; status: string;
  icon: typeof Brain; color: string;
  tasksCompleted: number; tasksFailed: number; tokensUsed: number;
  currentTask?: string;
  // Orbit params
  orbitRadius: number; orbitSpeed: number; orbitOffset: number;
}

interface OrchestratorCoreProps {
  agents: AgentOrchestratorState[];
  orchestratorState: OrchestratorState;
}

export function OrchestratorCore({ agents, orchestratorState }: OrchestratorCoreProps) {
  const isRunning = orchestratorState === 'running';
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);
  const neuronsRef = useRef<Neuron[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const timeRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Build neurons with orbital parameters
  const neurons = useMemo(() => {
    if (agents.length === 0) return [];
    return agents.map((agent, i) => {
      const dept = DEPT_ICONS[agent.department] || DEPT_ICONS.execution;
      const roleIcon = ROLE_ICONS[agent.role] || dept.icon;
      // Spread agents in concentric orbits by role
      const roleRadius = agent.role === 'director' ? 0.20 : agent.role === 'lead' ? 0.38 : 0.55;
      const jitter = (Math.random() - 0.5) * 0.10;
      return {
        id: agent.id, name: agent.name, role: agent.role,
        dept: agent.department, status: agent.status,
        icon: roleIcon, color: dept.color,
        tasksCompleted: agent.tasksCompleted || 0,
        tasksFailed: agent.tasksFailed || 0,
        tokensUsed: agent.tokensUsed || 0,
        currentTask: agent.currentTask,
        orbitRadius: roleRadius + jitter,
        orbitSpeed: 0.15 + Math.random() * 0.25 + (agent.status === 'working' ? 0.15 : 0),
        orbitOffset: (i / agents.length) * Math.PI * 2 + Math.random() * 0.5,
      };
    });
  }, [agents]);

  neuronsRef.current = neurons;

  // Canvas animation loop
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = rect.width;
    const H = rect.height;
    const cx = W / 2;
    const cy = H / 2;
    const t = timeRef.current;

    ctx.clearRect(0, 0, W, H);

    const currentNeurons = neuronsRef.current;
    if (currentNeurons.length === 0) return;

    // Calculate neuron positions
    const positions = currentNeurons.map(n => {
      const angle = n.orbitOffset + t * n.orbitSpeed * 0.01;
      const rx = n.orbitRadius * W * 0.45;
      const ry = n.orbitRadius * H * 0.42;
      return {
        x: cx + Math.cos(angle) * rx,
        y: cy + Math.sin(angle) * ry * 0.85 + Math.sin(angle * 1.3 + n.orbitOffset) * 8,
        neuron: n, angle,
      };
    });

    // ─── Draw dendrite connections (neuron-like curved lines) ───
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i];
        const b = positions[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxDist = W * 0.50;
        if (dist > maxDist) continue;

        const sameDept = a.neuron.dept === b.neuron.dept;
        const bothActive = a.neuron.status === 'working' && b.neuron.status === 'working';
        const alpha = (1 - dist / maxDist) * (sameDept ? 0.25 : 0.08) * (bothActive ? 2.5 : 1);

        // Curved dendrite path
        const midX = (a.x + b.x) / 2 + Math.sin(t * 0.02 + i + j) * 15;
        const midY = (a.y + b.y) / 2 + Math.cos(t * 0.015 + i * j) * 12;

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(midX, midY, b.x, b.y);
        ctx.strokeStyle = sameDept ? a.neuron.color : '#475569';
        ctx.globalAlpha = alpha;
        ctx.lineWidth = bothActive ? 1.2 : 0.6;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // ─── Neural impulse along dendrite ───
        if (alpha > 0.08) {
          const impulseCount = bothActive ? 3 : sameDept ? 1 : 0;
          for (let p = 0; p < impulseCount; p++) {
            const speed = 0.3 + p * 0.15;
            const progress = ((t * speed * 0.008 + p * 0.33 + i * 0.17 + j * 0.13) % 1);
            const tt = progress;
            // Quadratic bezier position
            const px = (1 - tt) * (1 - tt) * a.x + 2 * (1 - tt) * tt * midX + tt * tt * b.x;
            const py = (1 - tt) * (1 - tt) * a.y + 2 * (1 - tt) * tt * midY + tt * tt * b.y;
            const impulseAlpha = Math.sin(tt * Math.PI) * 0.9;

            // Glowing impulse dot
            const grad = ctx.createRadialGradient(px, py, 0, px, py, 6);
            grad.addColorStop(0, sameDept ? a.neuron.color : '#06b6d4');
            grad.addColorStop(1, 'transparent');
            ctx.beginPath();
            ctx.arc(px, py, 6, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.globalAlpha = impulseAlpha * (bothActive ? 0.7 : 0.35);
            ctx.fill();
            ctx.globalAlpha = 1;

            // Bright core
            ctx.beginPath();
            ctx.arc(px, py, 1.5, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.globalAlpha = impulseAlpha * 0.8;
            ctx.fill();
            ctx.globalAlpha = 1;
          }
        }
      }
    }

    // ─── Draw neuron bodies ───
    positions.forEach((pos) => {
      const n = pos.neuron;
      const isActive = n.status === 'working';
      const isPaused = n.status === 'paused';
      const isHovered = hoveredId === n.id;
      const radius = isHovered ? 22 : isActive ? 18 : 15;

      // Outer glow
      const glowSize = isActive ? 35 + Math.sin(t * 0.04) * 8 : 20;
      const glowGrad = ctx.createRadialGradient(pos.x, pos.y, radius * 0.5, pos.x, pos.y, glowSize);
      glowGrad.addColorStop(0, isActive ? `${n.color}40` : `${n.color}15`);
      glowGrad.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, glowSize, 0, Math.PI * 2);
      ctx.fillStyle = glowGrad;
      ctx.fill();

      // Neuron body
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? '#0f172a' : '#1e293b';
      ctx.fill();

      // Border
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = isActive ? '#06b6d4' : isPaused ? '#f59e0b' : n.color;
      ctx.globalAlpha = isActive ? 0.6 + Math.sin(t * 0.05) * 0.3 : 0.25;
      ctx.lineWidth = isActive ? 2 : 1;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Active: second pulse ring
      if (isActive) {
        const pulseR = radius + 4 + Math.sin(t * 0.06) * 6;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, pulseR, 0, Math.PI * 2);
        ctx.strokeStyle = '#06b6d4';
        ctx.globalAlpha = 0.15 + Math.sin(t * 0.06) * 0.1;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    });

    timeRef.current += 1;
    frameRef.current = requestAnimationFrame(draw);
  }, [hoveredId]);

  useEffect(() => {
    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, [draw]);

  // Mouse tracking for hover detection
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setMousePos({ x: mx, y: my });

    const W = rect.width;
    const H = rect.height;
    const cx = W / 2;
    const cy = H / 2;
    const t = timeRef.current;

    // Check which neuron is hovered
    let found: string | null = null;
    for (const n of neuronsRef.current) {
      const angle = n.orbitOffset + t * n.orbitSpeed * 0.01;
      const rx = n.orbitRadius * W * 0.45;
      const ry = n.orbitRadius * H * 0.42;
      const nx = cx + Math.cos(angle) * rx;
      const ny = cy + Math.sin(angle) * ry * 0.85 + Math.sin(angle * 1.3 + n.orbitOffset) * 8;
      const dist = Math.sqrt((mx - nx) ** 2 + (my - ny) ** 2);
      if (dist < 25) { found = n.id; break; }
    }
    setHoveredId(found);
  }, []);

  const hoveredNeuron = neurons.find(n => n.id === hoveredId);

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: '100%', minHeight: 540 }}
      onMouseMove={handleMouseMove} onMouseLeave={() => setHoveredId(null)}>

      {/* Canvas for animation */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" style={{ cursor: hoveredId ? 'pointer' : 'default' }} />

      {/* DOM icons overlaid on neurons (redrawn each frame via CSS) */}
      {neurons.map((n, i) => {
        const Icon = n.icon;
        const isActive = n.status === 'working';
        return (
          <NeuronIcon key={n.id} neuron={n} index={i} total={neurons.length}
            containerRef={containerRef} timeRef={timeRef} isActive={isActive} />
        );
      })}

      {/* Hover tooltip */}
      {hoveredNeuron && (
        <div className="absolute pointer-events-none" style={{
          left: mousePos.x, top: mousePos.y + 30,
          transform: 'translateX(-50%)',
          zIndex: 30,
        }}>
          <div className="bg-slate-950/95 backdrop-blur-md rounded-xl px-4 py-3 shadow-2xl border border-slate-700/50 min-w-[200px]"
            style={{ animation: 'tooltip-in 0.15s ease-out' }}>
            <div className="flex items-center gap-2.5 mb-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${hoveredNeuron.color}20` }}>
                <hoveredNeuron.icon className="w-4 h-4" style={{ color: hoveredNeuron.color }} />
              </div>
              <div>
                <p className="text-[11px] font-bold text-white">{hoveredNeuron.name}</p>
                <p className="text-[9px] text-slate-400 capitalize">{hoveredNeuron.role} · {hoveredNeuron.dept}</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 mb-2">
              <span className={cn('w-2 h-2 rounded-full',
                hoveredNeuron.status === 'working' ? 'bg-cyan-400' :
                  hoveredNeuron.status === 'paused' ? 'bg-amber-400' : 'bg-emerald-400',
              )} />
              <span className={cn('text-[10px] font-medium',
                hoveredNeuron.status === 'working' ? 'text-cyan-400' :
                  hoveredNeuron.status === 'paused' ? 'text-amber-400' : 'text-emerald-400',
              )}>
                {hoveredNeuron.status === 'working' ? 'Processing' : hoveredNeuron.status === 'paused' ? 'Paused' : 'Ready'}
              </span>
            </div>
            {hoveredNeuron.currentTask && (
              <div className="mb-2 px-2 py-1.5 bg-cyan-950/30 rounded-lg border border-cyan-800/20">
                <p className="text-[8px] text-cyan-500 uppercase tracking-wider mb-0.5">Current Task</p>
                <p className="text-[10px] text-slate-300">{hoveredNeuron.currentTask}</p>
              </div>
            )}
            <div className="flex items-center gap-3 text-[9px] pt-1.5 border-t border-slate-700/30">
              <span className="text-emerald-400">{hoveredNeuron.tasksCompleted} done</span>
              {hoveredNeuron.tasksFailed > 0 && <span className="text-red-400">{hoveredNeuron.tasksFailed} failed</span>}
              {hoveredNeuron.tokensUsed > 0 && <span className="text-slate-500">{(hoveredNeuron.tokensUsed / 1000).toFixed(1)}K tok</span>}
            </div>
          </div>
        </div>
      )}

      {/* Recommendations */}
      <RecsOverlay agents={agents} />

      <style>{`
        @keyframes tooltip-in { from { opacity:0; transform:translateX(-50%) translateY(4px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
      `}</style>
    </div>
  );
}

// ─── Neuron Icon (follows canvas position via rAF) ──────────────

function NeuronIcon({ neuron, index, total, containerRef, timeRef, isActive }: {
  neuron: Neuron; index: number; total: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  timeRef: React.MutableRefObject<number>;
  isActive: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let running = true;
    const update = () => {
      if (!running || !ref.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      const cx = W / 2;
      const cy = H / 2;
      const t = timeRef.current;
      const angle = neuron.orbitOffset + t * neuron.orbitSpeed * 0.01;
      const rx = neuron.orbitRadius * W * 0.45;
      const ry = neuron.orbitRadius * H * 0.42;
      const x = cx + Math.cos(angle) * rx;
      const y = cy + Math.sin(angle) * ry * 0.85 + Math.sin(angle * 1.3 + neuron.orbitOffset) * 8;
      ref.current.style.transform = `translate(${x - 9}px, ${y - 9}px)`;
      requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
    return () => { running = false; };
  }, [neuron, containerRef, timeRef]);

  const Icon = neuron.icon;
  return (
    <div ref={ref} className="absolute top-0 left-0 pointer-events-none" style={{ zIndex: 11, willChange: 'transform' }}>
      <Icon className="w-[18px] h-[18px]" style={{
        color: isActive ? '#06b6d4' : neuron.color,
        filter: isActive ? 'drop-shadow(0 0 4px rgba(6,182,212,0.6))' : 'none',
      }} />
    </div>
  );
}

// ─── Recommendations ────────────────────────────────────────────

function RecsOverlay({ agents }: { agents: AgentOrchestratorState[] }) {
  const recs = useMemo(() => {
    const r: Array<{ msg: string; type: 'error' | 'warn' | 'info' }> = [];
    const paused = agents.filter(a => a.status === 'paused');
    const idle = agents.filter(a => a.status === 'idle');
    const working = agents.filter(a => a.status === 'working');
    const failed = agents.filter(a => (a.tasksFailed || 0) > 0);
    if (failed.length > 0) r.push({ msg: `${failed[0].name}: ${failed[0].tasksFailed} failures`, type: 'error' });
    if (paused.length > 0) r.push({ msg: `${paused.length} paused — check budgets`, type: 'warn' });
    if (idle.length > 3 && working.length < 2) r.push({ msg: `${idle.length} idle — assign via Kanban`, type: 'info' });
    return r;
  }, [agents]);

  if (recs.length === 0) return null;
  return (
    <div className="absolute bottom-2 left-3 right-3 space-y-1" style={{ zIndex: 20 }}>
      {recs.slice(0, 2).map((rec, i) => (
        <div key={i} className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] backdrop-blur-md border hover:translate-x-1 transition-transform',
          rec.type === 'error' ? 'bg-red-950/60 border-red-800/25 text-red-300' :
            rec.type === 'warn' ? 'bg-amber-950/60 border-amber-800/25 text-amber-300' :
            'bg-slate-900/70 border-slate-700/25 text-slate-400',
        )}>
          {rec.type !== 'info' ? <AlertTriangle className={cn('w-3 h-3 shrink-0', rec.type === 'error' ? 'text-red-400 animate-pulse' : 'text-amber-400')} /> :
            <Lightbulb className="w-3 h-3 text-slate-500 shrink-0" />}
          {rec.msg}
        </div>
      ))}
    </div>
  );
}
