/**
 * @revamp/ui - Components barrel export
 *
 * Boundary: zero @revamp/core imports, zero business logic.
 * These are atomic UI primitives (shadcn-style) + simple display components.
 */

// ─── Shadcn Atoms ──────────────────────────────────────────────
export { Badge, badgeVariants } from './badge';
export { Button, buttonVariants } from './button';
export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent } from './card';
export { Dialog, DialogPortal, DialogOverlay, DialogClose, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from './dialog';
export { Input } from './input';

// ─── Animation Components ──────────────────────────────────────
export { TypingBot } from './typing-bot';

// ─── Domain Display Components ─────────────────────────────────
export { ConfidenceGauge } from './confidence-gauge';
export { TerminalLog } from './terminal-log';
export { ApprovalGateComponent } from './approval-gate';
export { StageProgress } from './stage-progress';

// ─── Types ─────────────────────────────────────────────────────
export type { ConfidenceGaugeProps } from './confidence-gauge';
export type { TerminalLogProps, LogEntry } from './terminal-log';
export type { ApprovalGateComponentProps } from './approval-gate';
export type { StageProgressProps } from './stage-progress';
