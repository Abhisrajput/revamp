'use client';

import { useState, useMemo, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, FileCode, ChevronDown, ArrowLeftRight,
  Plus, Minus, Loader2,
} from 'lucide-react';
import Link from 'next/link';
import { Button } from '@revamp/ui/components/button';
import { Card, CardContent } from '@revamp/ui/components/card';
import { Badge } from '@revamp/ui/components/badge';
import { DiffReview } from '@/components/pipeline/diff-review';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

// --- Types ---

interface FilePair {
  path: string;
  originalContent: string;
  modernizedContent: string;
  language: string;
  stats: { added: number; removed: number; modified: number };
}

// --- Helpers ---

function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
    py: 'Python', java: 'Java', go: 'Go', rs: 'Rust', rb: 'Ruby',
    cs: 'C#', vb: 'VB.NET', cob: 'COBOL', cbl: 'COBOL', pas: 'Delphi',
    f90: 'Fortran', f: 'Fortran', pbl: 'PowerBuilder',
    sql: 'SQL', json: 'JSON', yaml: 'YAML', yml: 'YAML',
    xml: 'XML', html: 'HTML', css: 'CSS',
  };
  return langMap[ext] || ext.toUpperCase();
}

function computeLineStats(original: string, modified: string) {
  const oldLines = new Set(original.split('\n'));
  const newLines = modified.split('\n');
  let added = 0;
  let removed = 0;

  for (const line of newLines) {
    if (!oldLines.has(line)) added++;
  }

  const newLineSet = new Set(newLines);
  for (const line of oldLines) {
    if (!newLineSet.has(line)) removed++;
  }

  return { added, removed, modified: Math.min(added, removed) };
}

// --- Page ---

export default function CodeComparisonPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params.id;

  const [selectedFileIndex, setSelectedFileIndex] = useState(0);
  const [isFileDropdownOpen, setIsFileDropdownOpen] = useState(false);

  // Fetch stage artifacts for original and modernized code
  const { data: artifacts, isLoading } = useQuery({
    queryKey: ['compare-artifacts', projectId],
    queryFn: async () => {
      const res = await apiClient.get(`/projects/${projectId}/artifacts?types=original,modernized`);
      return res.data;
    },
    enabled: !!projectId,
  });

  // Build file pairs from artifacts
  const filePairs: FilePair[] = useMemo(() => {
    if (!artifacts?.original || !artifacts?.modernized) return [];

    const originalMap = new Map<string, string>();
    for (const file of artifacts.original) {
      originalMap.set(file.path, file.content || '');
    }

    return (artifacts.modernized || []).map((file: any) => {
      const originalContent = originalMap.get(file.original_path || file.path) || '';
      const modernizedContent = file.content || '';
      return {
        path: file.path,
        originalContent,
        modernizedContent,
        language: getLanguageFromPath(file.path),
        stats: computeLineStats(originalContent, modernizedContent),
      };
    });
  }, [artifacts]);

  const currentFile = filePairs[selectedFileIndex] || null;

  // Summary stats across all files
  const totalStats = useMemo(() => {
    return filePairs.reduce(
      (acc, f) => ({
        added: acc.added + f.stats.added,
        removed: acc.removed + f.stats.removed,
        files: acc.files + 1,
      }),
      { added: 0, removed: 0, files: 0 },
    );
  }, [filePairs]);

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' && e.altKey) {
        e.preventDefault();
        setSelectedFileIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'ArrowDown' && e.altKey) {
        e.preventDefault();
        setSelectedFileIndex((i) => Math.min(filePairs.length - 1, i + 1));
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [filePairs.length]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-screen-2xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link
                href={`/projects/${projectId}`}
                className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
              </Link>
              <div>
                <h1 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                  <ArrowLeftRight className="w-4 h-4 text-slate-500" />
                  Code Comparison
                </h1>
                <p className="text-[10px] text-slate-500">Legacy vs. Modernized</p>
              </div>
            </div>

            {/* Summary Stats */}
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5">
                <FileCode className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-xs text-slate-600 dark:text-slate-400">
                  {totalStats.files} files
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5 text-green-500" />
                <span className="text-xs text-green-600 dark:text-green-400 tabular-nums">
                  {totalStats.added}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Minus className="w-3.5 h-3.5 text-red-500" />
                <span className="text-xs text-red-600 dark:text-red-400 tabular-nums">
                  {totalStats.removed}
                </span>
              </div>
            </div>
          </div>

          {/* File Selector */}
          {filePairs.length > 0 && (
            <div className="mt-2 relative">
              <button
                onClick={() => setIsFileDropdownOpen(!isFileDropdownOpen)}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-750 transition-colors"
              >
                <FileCode className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="font-mono text-slate-700 dark:text-slate-300 truncate flex-1">
                  {currentFile?.path || 'Select a file'}
                </span>
                {currentFile && (
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    {currentFile.language}
                  </Badge>
                )}
                <ChevronDown className={cn('w-3.5 h-3.5 text-slate-400 transition-transform shrink-0', isFileDropdownOpen && 'rotate-180')} />
              </button>

              {isFileDropdownOpen && (
                <div className="absolute left-0 right-0 top-full mt-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg max-h-60 overflow-y-auto z-20">
                  {filePairs.map((file, idx) => (
                    <button
                      key={file.path}
                      onClick={() => {
                        setSelectedFileIndex(idx);
                        setIsFileDropdownOpen(false);
                      }}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors',
                        idx === selectedFileIndex && 'bg-primary-50 dark:bg-primary-900/20',
                      )}
                    >
                      <FileCode className="w-3 h-3 text-slate-400 shrink-0" />
                      <span className="font-mono truncate flex-1">{file.path}</span>
                      <span className="text-[10px] text-green-600 dark:text-green-400 tabular-nums shrink-0">+{file.stats.added}</span>
                      <span className="text-[10px] text-red-600 dark:text-red-400 tabular-nums shrink-0">-{file.stats.removed}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-screen-2xl mx-auto px-4 py-6">
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
            <span className="ml-2 text-sm text-slate-500">Loading artifacts...</span>
          </div>
        )}

        {!isLoading && filePairs.length === 0 && (
          <Card className="bg-slate-50 dark:bg-slate-900">
            <CardContent className="p-8 text-center">
              <ArrowLeftRight className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
              <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                No comparison data available
              </h3>
              <p className="text-xs text-slate-500">
                Complete the FORGE stage to generate modernized code for comparison.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4"
                onClick={() => router.push(`/projects/${projectId}`)}
              >
                Return to Pipeline
              </Button>
            </CardContent>
          </Card>
        )}

        {currentFile && (
          <div className="space-y-4">
            {/* File navigation */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={selectedFileIndex === 0}
                  onClick={() => setSelectedFileIndex((i) => i - 1)}
                  className="h-7 text-xs"
                >
                  Previous
                </Button>
                <span className="text-xs text-slate-500 tabular-nums">
                  {selectedFileIndex + 1} / {filePairs.length}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={selectedFileIndex === filePairs.length - 1}
                  onClick={() => setSelectedFileIndex((i) => i + 1)}
                  className="h-7 text-xs"
                >
                  Next
                </Button>
              </div>
              <span className="text-[10px] text-slate-400">
                Alt+Arrow to navigate
              </span>
            </div>

            {/* Diff View */}
            <DiffReview
              original={currentFile.originalContent}
              modified={currentFile.modernizedContent}
              fileName={currentFile.path}
              language={currentFile.language}
              showActions={false}
              maxHeight="calc(100vh - 280px)"
            />
          </div>
        )}
      </div>
    </div>
  );
}
