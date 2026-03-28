'use client';

import { memo } from 'react';
import { cn } from '@/lib/utils';

// --- Types ---

interface ConfidenceGaugeProps {
  /** Score from 0 to 100 */
  score: number;
  /** Size of the gauge in pixels */
  size?: number;
  /** Label shown below the score */
  label?: string;
  /** Additional CSS class */
  className?: string;
  /** Show the numeric score */
  showScore?: boolean;
}

// --- Color helpers ---

function getScoreColor(score: number): { stroke: string; text: string; bg: string } {
  if (score >= 80) return { stroke: '#22c55e', text: 'text-green-600 dark:text-green-400', bg: 'bg-green-50 dark:bg-green-900/20' };
  if (score >= 60) return { stroke: '#eab308', text: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-900/20' };
  if (score >= 40) return { stroke: '#f97316', text: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-900/20' };
  return { stroke: '#ef4444', text: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20' };
}

function getGrade(score: number): string {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

// --- Component ---

export const ConfidenceGauge = memo(function ConfidenceGauge({
  score,
  size = 120,
  label = 'Confidence',
  className,
  showScore = true,
}: ConfidenceGaugeProps) {
  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  const colors = getScoreColor(clampedScore);
  const grade = getGrade(clampedScore);

  // SVG circle calculations
  const strokeWidth = size * 0.08;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clampedScore / 100) * circumference;
  const center = size / 2;

  return (
    <div className={cn('flex flex-col items-center', className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="transform -rotate-90">
          {/* Background circle */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            className="text-slate-200 dark:text-slate-700"
          />
          {/* Progress circle */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={colors.stroke}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-all duration-700 ease-out"
          />
        </svg>
        {/* Center content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {showScore && (
            <>
              <span className={cn('font-bold tabular-nums', colors.text)} style={{ fontSize: size * 0.22 }}>
                {clampedScore}
              </span>
              <span className="text-slate-400 -mt-0.5" style={{ fontSize: size * 0.1 }}>
                / 100
              </span>
            </>
          )}
          {!showScore && (
            <span className={cn('font-bold', colors.text)} style={{ fontSize: size * 0.28 }}>
              {grade}
            </span>
          )}
        </div>
      </div>
      {label && (
        <span className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 font-medium">
          {label}
        </span>
      )}
    </div>
  );
});

// --- Inline variant for use in cards/tables ---

interface InlineConfidenceProps {
  score: number;
  className?: string;
}

export const InlineConfidence = memo(function InlineConfidence({ score, className }: InlineConfidenceProps) {
  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  const colors = getScoreColor(clampedScore);

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${clampedScore}%`, backgroundColor: colors.stroke }}
        />
      </div>
      <span className={cn('text-xs font-semibold tabular-nums', colors.text)}>
        {clampedScore}%
      </span>
    </div>
  );
});
