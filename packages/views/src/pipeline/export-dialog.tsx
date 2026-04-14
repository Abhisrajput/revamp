

import { useState } from 'react';
import { Download, FileText, Code, Loader2, X, CheckCircle2 } from 'lucide-react';
import { Badge } from '@revamp/ui/components/badge';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

interface ExportDialogProps {
  projectId: string;
  projectName: string;
  token: string | null;
  onClose: () => void;
}

export function ExportDialog({ projectId, projectName, token, onClose }: ExportDialogProps) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [completed, setCompleted] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async (type: 'report' | 'code' | 'summary') => {
    setDownloading(type);
    setError(null);

    try {
      const url = `${API_BASE_URL}/export/project/${projectId}/${type}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: type === 'summary' ? 'application/json' : 'application/octet-stream',
        },
      });

      if (!response.ok) {
        const err = await response.text().catch(() => 'Export failed');
        throw new Error(err);
      }

      if (type === 'summary') {
        const data = await response.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        downloadBlob(blob, `${projectName}-summary.json`);
      } else {
        const contentType = response.headers.get('content-type') || '';
        const blob = await response.blob();

        if (type === 'report') {
          downloadBlob(blob, `${projectName}-report.md`);
        } else {
          const ext = contentType.includes('zip') ? 'zip' : 'json';
          downloadBlob(blob, `${projectName}-code.${ext}`);
        }
      }

      setCompleted((prev) => [...prev, type]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary-100 dark:bg-primary-900/30">
              <Download className="w-5 h-5 text-primary-600 dark:text-primary-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Export Project</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">{projectName}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-3">
          <ExportOption
            title="Full Report"
            description="Comprehensive markdown report with all stage outputs, validation results, and recommendations"
            icon={<FileText className="w-5 h-5" />}
            format="Markdown"
            isDownloading={downloading === 'report'}
            isCompleted={completed.includes('report')}
            onClick={() => handleExport('report')}
          />

          <ExportOption
            title="Modernized Code"
            description="ZIP archive of all generated code files, or JSON bundle if no workspace exists"
            icon={<Code className="w-5 h-5" />}
            format="ZIP / JSON"
            isDownloading={downloading === 'code'}
            isCompleted={completed.includes('code')}
            onClick={() => handleExport('code')}
          />

          <ExportOption
            title="Quick Summary"
            description="Project configuration, stage progress, team info, and key metrics"
            icon={<Download className="w-5 h-5" />}
            format="JSON"
            isDownloading={downloading === 'summary'}
            isCompleted={completed.includes('summary')}
            onClick={() => handleExport('summary')}
          />

          {error && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
          <p className="text-xs text-slate-400 dark:text-slate-500 text-center">
            Exports are generated from the latest pipeline artifacts
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Export Option Row ─────────────────────────────────────────────

function ExportOption({
  title,
  description,
  icon,
  format,
  isDownloading,
  isCompleted,
  onClick,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  format: string;
  isDownloading: boolean;
  isCompleted: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={isDownloading}
      className="w-full flex items-start gap-4 p-4 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-primary-300 dark:hover:border-primary-700 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors text-left disabled:opacity-60"
    >
      <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 shrink-0">
        {isDownloading ? (
          <Loader2 className="w-5 h-5 animate-spin text-primary-600" />
        ) : isCompleted ? (
          <CheckCircle2 className="w-5 h-5 text-green-500" />
        ) : (
          icon
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-medium text-slate-900 dark:text-slate-50">{title}</h4>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">{format}</Badge>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>
      </div>
    </button>
  );
}

// ─── Helper ────────────────────────────────────────────────────────

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
