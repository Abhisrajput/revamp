/**
 * Stage progress indicator component
 * Displays progress through pipeline stages with status indicators
 */

import React from 'react';
import { PipelineStageName, PipelineStageRun, StageStatus } from '@revamp/shared-types/pipeline';

export interface StageProgressProps {
  stages: PipelineStageRun[];
  currentStage?: PipelineStageName;
  onStageClick?: (stageName: PipelineStageName) => void;
  className?: string;
  showLabels?: boolean;
}

const stageLabels: Record<PipelineStageName, string> = {
  [PipelineStageName.SCAN]: 'Scan',
  [PipelineStageName.DECODE]: 'Decode',
  [PipelineStageName.BLUEPRINT]: 'Blueprint',
  [PipelineStageName.SPEC_LOCK]: 'Spec Lock',
  [PipelineStageName.ARCHITECT]: 'Architect',
  [PipelineStageName.FORGE]: 'Forge',
  [PipelineStageName.SHADOW_RUN]: 'Shadow Run',
  [PipelineStageName.EVOLVE]: 'Evolve',
};

const statusStyles: Record<StageStatus, { bg: string; text: string; icon: string }> = {
  [StageStatus.PENDING]: {
    bg: 'bg-gray-200',
    text: 'text-gray-700',
    icon: '○',
  },
  [StageStatus.IN_PROGRESS]: {
    bg: 'bg-blue-400',
    text: 'text-white',
    icon: '⟳',
  },
  [StageStatus.COMPLETED]: {
    bg: 'bg-green-500',
    text: 'text-white',
    icon: '✓',
  },
  [StageStatus.FAILED]: {
    bg: 'bg-red-500',
    text: 'text-white',
    icon: '✕',
  },
  [StageStatus.SKIPPED]: {
    bg: 'bg-yellow-400',
    text: 'text-white',
    icon: '⊘',
  },
  [StageStatus.AWAITING_APPROVAL]: {
    bg: 'bg-orange-400',
    text: 'text-white',
    icon: '⧗',
  },
};

interface StageIndicator {
  order: number;
  name: PipelineStageName;
  status: StageStatus;
  duration?: number;
  errorMessage?: string;
}

export const StageProgress: React.FC<StageProgressProps> = ({
  stages,
  currentStage,
  onStageClick,
  className = '',
  showLabels = true,
}) => {
  const stageIndicators: StageIndicator[] = stages.map((stage) => ({
    order: stage.stageOrder,
    name: stage.stageName,
    status: stage.status,
    duration: stage.duration,
    errorMessage: stage.errorMessage,
  }));

  const sortedStages = stageIndicators.sort((a, b) => a.order - b.order);
  const completedCount = stageIndicators.filter(
    (s) => s.status === StageStatus.COMPLETED,
  ).length;

  return (
    <div className={`w-full ${className}`}>
      {/* Progress bar */}
      <div className="mb-4">
        <div className="flex justify-between text-xs text-gray-600 mb-2">
          <span>Progress</span>
          <span>
            {completedCount}/{sortedStages.length}
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-blue-500 h-2 rounded-full transition-all duration-500"
            style={{
              width: `${(completedCount / sortedStages.length) * 100}%`,
            }}
          />
        </div>
      </div>

      {/* Stages */}
      <div className="flex items-start gap-2">
        {sortedStages.map((stage, idx) => {
          const style = statusStyles[stage.status];
          const isActive = currentStage === stage.name;
          const isPast = idx < sortedStages.findIndex((s) => s.status === StageStatus.IN_PROGRESS);

          return (
            <React.Fragment key={stage.name}>
              {/* Stage circle */}
              <div
                className="flex flex-col items-center gap-1 flex-1"
                onClick={() => onStageClick?.(stage.name)}
              >
                <div
                  className={`
                    w-10 h-10 rounded-full flex items-center justify-center font-bold
                    transition-all duration-300 cursor-pointer
                    ${style.bg} ${style.text}
                    ${isActive ? 'ring-2 ring-offset-2 ring-blue-500' : ''}
                    hover:ring-2 hover:ring-offset-2 hover:ring-gray-300
                  `}
                  title={stage.errorMessage || stageLabels[stage.name]}
                >
                  <span
                    className={
                      stage.status === StageStatus.IN_PROGRESS
                        ? 'animate-spin'
                        : ''
                    }
                  >
                    {style.icon}
                  </span>
                </div>

                {showLabels && (
                  <div className="text-xs text-center text-gray-700 w-full px-1">
                    <div className="font-semibold line-clamp-2">
                      {stageLabels[stage.name]}
                    </div>

                    {stage.duration && stage.status === StageStatus.COMPLETED && (
                      <div className="text-gray-500 text-xs">
                        {(stage.duration / 1000).toFixed(1)}s
                      </div>
                    )}

                    {stage.status === StageStatus.FAILED && (
                      <div className="text-red-600 text-xs mt-1">
                        Failed
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Connector line */}
              {idx < sortedStages.length - 1 && (
                <div
                  className={`flex-1 h-0.5 mt-5 ${
                    stage.status === StageStatus.COMPLETED
                      ? 'bg-green-500'
                      : 'bg-gray-300'
                  }`}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* Current stage details */}
      {currentStage && (
        <div className="mt-6 p-4 bg-gray-50 rounded-lg">
          <div className="font-semibold text-gray-800 mb-2">
            {stageLabels[currentStage]}
          </div>

          {stages.find((s) => s.stageName === currentStage)?.errorMessage && (
            <div className="text-sm text-red-600 mb-2">
              {stages.find((s) => s.stageName === currentStage)?.errorMessage}
            </div>
          )}

          {stages.find((s) => s.stageName === currentStage)?.artifacts &&
            stages.find((s) => s.stageName === currentStage)!.artifacts.length >
              0 && (
              <div className="text-sm">
                <div className="font-semibold text-gray-700 mb-1">
                  Artifacts:
                </div>
                <ul className="list-disc list-inside text-gray-600 space-y-0.5">
                  {stages
                    .find((s) => s.stageName === currentStage)
                    ?.artifacts.map((artifact) => (
                      <li key={artifact.id} className="text-xs">
                        {artifact.name}
                      </li>
                    ))}
                </ul>
              </div>
            )}
        </div>
      )}
    </div>
  );
};

export default StageProgress;
