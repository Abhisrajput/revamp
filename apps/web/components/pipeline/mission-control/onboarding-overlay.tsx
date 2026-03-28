'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  X,
  ChevronRight,
  ChevronLeft,
  Lightbulb,
  Keyboard,
  Layers,
  SplitSquareVertical,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────

interface OnboardingStep {
  title: string;
  description: string;
  icon: React.ReactNode;
  highlight?: string; // CSS selector to highlight
}

const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    title: 'Mission Control Layout',
    description: 'Your pipeline workspace has 4 panels: Left Rail for navigation and settings, Center for stage content, Right Inspector for validation and artifacts, and Bottom Dock for logs and history.',
    icon: <SplitSquareVertical className="w-5 h-5" />,
  },
  {
    title: 'Stage Navigation',
    description: 'Click any stage in the left rail to navigate. Stages unlock sequentially — complete one to unlock the next. Right-click a stage for quick actions like Execute, Reset, or Copy Output.',
    icon: <Layers className="w-5 h-5" />,
  },
  {
    title: 'Keyboard Shortcuts',
    description: 'Use Cmd+K for the Command Palette, Ctrl+Enter to execute, Alt+Arrow for stage navigation, and Cmd+1-8 to jump to any stage. Toggle panels with Cmd+B, Cmd+., and Cmd+J.',
    icon: <Keyboard className="w-5 h-5" />,
  },
  {
    title: 'Quick Settings',
    description: 'Configure LLM model, evaluator model, and prompt template per-stage from the left rail. Enable Deep Analysis for more thorough extraction. Use Cmd+Shift+P to edit the stage prompt inline.',
    icon: <Lightbulb className="w-5 h-5" />,
  },
];

const STORAGE_KEY = 'revamp-onboarding-dismissed';

// ─── Component ──────────────────────────────────────────────────

export function OnboardingOverlay() {
  const [visible, setVisible] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    // Check if user has already dismissed onboarding
    try {
      const dismissed = localStorage.getItem(STORAGE_KEY);
      if (!dismissed) {
        // Small delay so the layout renders first
        const timer = setTimeout(() => setVisible(true), 1200);
        return () => clearTimeout(timer);
      }
    } catch {
      // localStorage unavailable — skip onboarding
    }
    return undefined;
  }, []);

  const dismiss = useCallback(() => {
    setVisible(false);
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      // ignore
    }
  }, []);

  const nextStep = useCallback(() => {
    if (currentStep < ONBOARDING_STEPS.length - 1) {
      setCurrentStep((s) => s + 1);
    } else {
      dismiss();
    }
  }, [currentStep, dismiss]);

  const prevStep = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep((s) => s - 1);
    }
  }, [currentStep]);

  if (!visible) return null;

  const step = ONBOARDING_STEPS[currentStep];
  const isLast = currentStep === ONBOARDING_STEPS.length - 1;

  return (
    <div className="fixed bottom-6 right-6 z-[9999] flex items-end justify-end pointer-events-none">
      {/* No backdrop — overlay is now a non-blocking floating card */}

      {/* Floating card — does not block page interaction */}
      <div
        className={cn(
          'relative w-full max-w-sm pointer-events-auto',
          'bg-white dark:bg-slate-800',
          'rounded-xl shadow-2xl',
          'border border-slate-200 dark:border-slate-700',
          'animate-in fade-in-0 slide-in-from-bottom-4 duration-200',
        )}
      >
        {/* Close button */}
        <button
          onClick={dismiss}
          className="absolute top-3 right-3 p-1 rounded-md text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Content */}
        <div className="p-6">
          {/* Icon */}
          <div className="w-10 h-10 rounded-lg bg-primary-100 dark:bg-primary-900/30 flex items-center justify-center text-primary-600 dark:text-primary-400 mb-4">
            {step.icon}
          </div>

          {/* Title & description */}
          <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
            {step.title}
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            {step.description}
          </p>
        </div>

        {/* Footer */}
        <div className="px-6 pb-5 flex items-center justify-between">
          {/* Step indicator dots */}
          <div className="flex items-center gap-1.5">
            {ONBOARDING_STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setCurrentStep(i)}
                className={cn(
                  'w-1.5 h-1.5 rounded-full transition-all',
                  i === currentStep
                    ? 'w-4 bg-primary-500'
                    : 'bg-slate-300 dark:bg-slate-600 hover:bg-slate-400',
                )}
              />
            ))}
          </div>

          {/* Navigation */}
          <div className="flex items-center gap-2">
            <button
              onClick={dismiss}
              className="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 px-2 py-1 transition-colors"
            >
              Skip
            </button>

            {currentStep > 0 && (
              <button
                onClick={prevStep}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              >
                <ChevronLeft className="w-3 h-3" />
                Back
              </button>
            )}

            <button
              onClick={nextStep}
              className={cn(
                'flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                'bg-primary-600 text-white hover:bg-primary-700',
              )}
            >
              {isLast ? 'Get Started' : 'Next'}
              {!isLast && <ChevronRight className="w-3 h-3" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
