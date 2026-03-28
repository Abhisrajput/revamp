'use client';

import { useEffect } from 'react';
import { AlertTriangle, RotateCcw, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

export default function PipelineError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams();

  useEffect(() => {
    console.error('[Pipeline Error]', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center py-20">
      <div className="flex items-center justify-center w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/20 mb-6">
        <AlertTriangle className="w-8 h-8 text-red-600 dark:text-red-400" />
      </div>
      <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-50 mb-2">
        Pipeline Error
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-1 max-w-md text-center">
        {error.message || 'An error occurred while loading the pipeline.'}
      </p>
      {error.digest && (
        <p className="text-xs text-slate-400 dark:text-slate-500 mb-6 font-mono">
          ID: {error.digest}
        </p>
      )}
      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={reset}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
        >
          <RotateCcw className="w-4 h-4" />
          Retry
        </button>
        <Link
          href={`/projects/${params.id}`}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Project
        </Link>
      </div>
    </div>
  );
}
