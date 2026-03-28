/**
 * Circular confidence gauge component
 * Displays a percentage value (0-100%) as a circular progress indicator
 */

import React from 'react';

export interface ConfidenceGaugeProps {
  value: number; // 0-100
  size?: 'sm' | 'md' | 'lg'; // Default: md
  showLabel?: boolean;
  showPercentage?: boolean;
  label?: string;
  className?: string;
  colorScheme?: 'green' | 'orange' | 'red' | 'blue';
}

const sizeMap = {
  sm: { canvas: 80, radius: 35, strokeWidth: 4 },
  md: { canvas: 120, radius: 50, strokeWidth: 5 },
  lg: { canvas: 160, radius: 70, strokeWidth: 6 },
};

const colorSchemes = {
  green: { bg: '#e8f5e9', text: '#2e7d32', stroke: '#66bb6a' },
  orange: { bg: '#fff3e0', text: '#e65100', stroke: '#ffa726' },
  red: { bg: '#ffebee', text: '#c62828', stroke: '#ef5350' },
  blue: { bg: '#e3f2fd', text: '#1565c0', stroke: '#42a5f5' },
};

export const ConfidenceGauge: React.FC<ConfidenceGaugeProps> = ({
  value,
  size = 'md',
  showLabel = true,
  showPercentage = true,
  label = 'Confidence',
  className = '',
  colorScheme = 'blue',
}) => {
  const clampedValue = Math.min(Math.max(value, 0), 100);
  const dimensions = sizeMap[size];
  const colors = colorSchemes[colorScheme];

  // Calculate circle progress
  const circumference = 2 * Math.PI * dimensions.radius;
  const strokeDashoffset =
    circumference - (clampedValue / 100) * circumference;

  return (
    <div className={`flex flex-col items-center gap-2 ${className}`}>
      <div style={{ width: dimensions.canvas, height: dimensions.canvas }}>
        <svg
          width={dimensions.canvas}
          height={dimensions.canvas}
          viewBox={`0 0 ${dimensions.canvas} ${dimensions.canvas}`}
        >
          {/* Background circle */}
          <circle
            cx={dimensions.canvas / 2}
            cy={dimensions.canvas / 2}
            r={dimensions.radius}
            fill={colors.bg}
            stroke={colors.stroke}
            strokeWidth={0.5}
          />

          {/* Progress circle */}
          <circle
            cx={dimensions.canvas / 2}
            cy={dimensions.canvas / 2}
            r={dimensions.radius}
            fill="none"
            stroke={colors.stroke}
            strokeWidth={dimensions.strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            style={{
              transform: 'rotate(-90deg)',
              transformOrigin: '50% 50%',
              transition: 'stroke-dashoffset 0.3s ease',
            }}
          />

          {/* Center text */}
          {showPercentage && (
            <text
              x={dimensions.canvas / 2}
              y={dimensions.canvas / 2 + 5}
              textAnchor="middle"
              fontSize={dimensions.canvas * 0.25}
              fontWeight="bold"
              fill={colors.text}
            >
              {Math.round(clampedValue)}%
            </text>
          )}
        </svg>
      </div>

      {showLabel && (
        <div
          className="text-center"
          style={{ color: colors.text }}
        >
          <p className="text-sm font-medium">{label}</p>
        </div>
      )}
    </div>
  );
};

export default ConfidenceGauge;
