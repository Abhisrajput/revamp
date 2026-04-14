

import { useState } from 'react';
import { ChevronDown, CheckCircle, Clock, AlertCircle, Play } from 'lucide-react';
import { Button } from '@revamp/ui/components/button';
import { Card } from '@revamp/ui/components/card';
import { cn } from '@revamp/ui/utils';

interface StageCardProps {
  stage: {
    id: number;
    name: string;
    description: string;
    status: 'pending' | 'in-progress' | 'completed';
  };
  stageNumber: number;
  isExpanded?: boolean;
}

const stageDescriptions: Record<number, string> = {
  1: 'Define scope, dependencies, target technologies, and success criteria for your modernization effort.',
  2: 'Analyze legacy code to understand original business intent, design patterns, and functional behavior.',
  3: 'Extract and map business capabilities, technical architecture, and system interactions.',
  4: 'Plan migration strategy using modern patterns, frameworks, and best practices.',
  5: 'Create comprehensive BDD test suites to lock in existing behavior before refactoring.',
  6: 'Generate modernized code with AI-powered pair programming assistance.',
  7: 'Implement monitoring, feedback loops, and continuous improvement mechanisms.',
  8: 'Deploy alongside legacy system with gradual traffic migration and rollback capability.',
};

export function StageCard({
  stage,
  stageNumber,
  isExpanded: initialExpanded = false,
}: StageCardProps) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />;
      case 'in-progress':
        return <Clock className="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" />;
      case 'pending':
        return <AlertCircle className="w-5 h-5 text-slate-400" />;
      default:
        return null;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800';
      case 'in-progress':
        return 'bg-blue-50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800';
      case 'pending':
        return 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700';
      default:
        return 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700';
    }
  };

  return (
    <Card
      className={cn(
        'transition-all cursor-pointer border-2',
        getStatusColor(stage.status)
      )}
      onClick={() => setIsExpanded(!isExpanded)}
    >
      <div className="p-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary-600 dark:bg-primary-700 flex items-center justify-center text-white font-semibold text-sm">
                {stageNumber}
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
                  {stage.name}
                </h3>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                  {stage.description}
                </p>
              </div>
            </div>
          </div>

          {/* Status and Expand */}
          <div className="flex items-center gap-4 flex-shrink-0">
            <div className="flex items-center gap-2">
              {getStatusIcon(stage.status)}
              <span className="text-xs font-medium text-slate-600 dark:text-slate-400 uppercase">
                {stage.status === 'in-progress'
                  ? 'In Progress'
                  : stage.status === 'completed'
                    ? 'Completed'
                    : 'Pending'}
              </span>
            </div>
            <ChevronDown
              className={cn(
                'w-5 h-5 text-slate-400 transition-transform',
                isExpanded && 'rotate-180'
              )}
            />
          </div>
        </div>

        {/* Expanded Content */}
        {isExpanded && (
          <div className="mt-6 pt-6 border-t border-slate-200 dark:border-slate-700 space-y-4">
            {/* Detailed Description */}
            <div>
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-2">
                Overview
              </h4>
              <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                {stageDescriptions[stageNumber] || stage.description}
              </p>
            </div>

            {/* Key Activities */}
            <div>
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-3">
                Key Activities
              </h4>
              <ul className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <li key={i} className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary-600" />
                    <span>Activity {i}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Deliverables */}
            <div>
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50 mb-3">
                Deliverables
              </h4>
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400 p-2 bg-white/50 dark:bg-slate-900/50 rounded"
                  >
                    <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400" />
                    <span>Deliverable {i}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Action Button */}
            {stage.status === 'in-progress' && (
              <Button className="w-full gap-2">
                <Play className="w-4 h-4" />
                Continue Stage
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
