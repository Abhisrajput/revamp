

import { useState, useMemo, useCallback, memo } from 'react';
import {
  ChevronRight, ChevronDown, Folder, FolderOpen,
  FileText, FileCode, FileJson, File as FileIcon,
  Search, Pencil, Trash2, MoreHorizontal,
} from 'lucide-react';
import { cn } from '@revamp/ui/utils';

// --- Types ---

export type FileStatus = 'added' | 'modified' | 'deleted';
export type FileAction = 'edit' | 'delete' | 'rename';

export interface FileNode {
  name: string;
  type: 'file' | 'directory';
  path?: string;
  language?: string;
  size?: number;
  children?: FileNode[];
}

interface FileTreeProps {
  nodes: FileNode[];
  onFileClick?: (node: FileNode, path: string) => void;
  selectedPath?: string;
  className?: string;
  showSearch?: boolean;
  maxHeight?: string;
  /** Show file status badges (added/modified/deleted) — Stage 7 (Evolve) feature */
  showStatus?: boolean;
  /** Map of file path to status */
  fileStatuses?: Record<string, FileStatus>;
  /** Callback for file actions (edit, delete, rename) — Stage 7 (Evolve) feature */
  onFileAction?: (path: string, action: FileAction) => void;
}

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  parentPath: string;
  onFileClick?: (node: FileNode, path: string) => void;
  selectedPath?: string;
  expandedPaths: Set<string>;
  toggleExpand: (path: string) => void;
  searchQuery: string;
  showStatus?: boolean;
  fileStatuses?: Record<string, FileStatus>;
  onFileAction?: (path: string, action: FileAction) => void;
}

// --- Status badge config ---

const FILE_STATUS_CONFIG: Record<FileStatus, { color: string; label: string; dotColor: string }> = {
  added: { color: 'text-green-500', label: 'A', dotColor: 'bg-green-500' },
  modified: { color: 'text-amber-500', label: 'M', dotColor: 'bg-amber-500' },
  deleted: { color: 'text-red-500', label: 'D', dotColor: 'bg-red-500' },
};

// --- Language Icons ---

const LANGUAGE_ICONS: Record<string, typeof FileCode> = {
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  go: FileCode,
  py: FileCode,
  java: FileCode,
  rs: FileCode,
  json: FileJson,
  yaml: FileJson,
  yml: FileJson,
  md: FileText,
  txt: FileText,
};

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return LANGUAGE_ICONS[ext] || FileIcon;
}

function getLanguageColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const colors: Record<string, string> = {
    ts: 'text-blue-400',
    tsx: 'text-blue-400',
    js: 'text-yellow-400',
    jsx: 'text-yellow-400',
    go: 'text-cyan-400',
    py: 'text-green-400',
    java: 'text-orange-400',
    rs: 'text-orange-500',
    json: 'text-yellow-500',
    yaml: 'text-pink-400',
    yml: 'text-pink-400',
    md: 'text-slate-400',
    css: 'text-purple-400',
    scss: 'text-pink-400',
    html: 'text-orange-400',
    sql: 'text-blue-300',
    sh: 'text-green-500',
    dockerfile: 'text-blue-500',
  };
  return colors[ext] || 'text-slate-400';
}

// --- Count files ---

function countFiles(nodes: FileNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === 'file') count++;
    if (node.children) count += countFiles(node.children);
  }
  return count;
}

// --- Filter tree by search ---

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  if (!query) return nodes;
  const lower = query.toLowerCase();

  return nodes
    .map((node) => {
      if (node.type === 'directory') {
        const filteredChildren = filterTree(node.children || [], query);
        if (filteredChildren.length > 0) {
          return { ...node, children: filteredChildren };
        }
        return null;
      }
      return node.name.toLowerCase().includes(lower) ? node : null;
    })
    .filter(Boolean) as FileNode[];
}

// --- Tree Node Component ---

function TreeNode({
  node,
  depth,
  parentPath,
  onFileClick,
  selectedPath,
  expandedPaths,
  toggleExpand,
  searchQuery,
  showStatus,
  fileStatuses,
  onFileAction,
}: TreeNodeProps) {
  const [showActions, setShowActions] = useState(false);
  const fullPath = parentPath ? `${parentPath}/${node.name}` : node.name;
  const isDir = node.type === 'directory';
  const isExpanded = expandedPaths.has(fullPath);
  const isSelected = selectedPath === fullPath;
  const Icon = isDir
    ? (isExpanded ? FolderOpen : Folder)
    : getFileIcon(node.name);

  const fileStatus = showStatus && fileStatuses ? fileStatuses[fullPath] : undefined;
  const statusCfg = fileStatus ? FILE_STATUS_CONFIG[fileStatus] : undefined;

  const handleClick = () => {
    if (isDir) {
      toggleExpand(fullPath);
    } else {
      onFileClick?.(node, fullPath);
    }
  };

  return (
    <div>
      <div
        className="group relative"
        onMouseEnter={() => setShowActions(true)}
        onMouseLeave={() => setShowActions(false)}
      >
        <button
          onClick={handleClick}
          className={cn(
            'w-full flex items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors',
            isSelected && 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-400',
            fileStatus === 'deleted' && 'opacity-60',
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          {isDir ? (
            isExpanded ? (
              <ChevronDown className="h-3 w-3 text-slate-400 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 text-slate-400 shrink-0" />
            )
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {/* Status dot indicator */}
          {statusCfg && (
            <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', statusCfg.dotColor)} title={fileStatus} />
          )}
          <Icon className={cn('h-3.5 w-3.5 shrink-0', isDir ? 'text-slate-500 dark:text-slate-400' : getLanguageColor(node.name))} />
          <span className={cn(
            'truncate',
            isDir ? 'font-medium text-slate-700 dark:text-slate-300' : 'text-slate-600 dark:text-slate-400',
            fileStatus === 'deleted' && 'line-through',
          )}>
            {node.name.replace(/\/$/, '')}
          </span>
          {/* Status badge */}
          {statusCfg && (
            <span className={cn('text-[10px] font-bold shrink-0', statusCfg.color)}>
              {statusCfg.label}
            </span>
          )}
          {isDir && node.children && !statusCfg && (
            <span className="text-[10px] text-slate-400 ml-auto tabular-nums">
              {countFiles(node.children)}
            </span>
          )}
        </button>

        {/* File action buttons (Evolve stage feature) */}
        {onFileAction && !isDir && showActions && (
          <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 bg-white dark:bg-slate-900 rounded shadow-sm border border-slate-200 dark:border-slate-700 px-0.5">
            <button
              onClick={(e) => { e.stopPropagation(); onFileAction(fullPath, 'edit'); }}
              className="p-0.5 text-slate-400 hover:text-blue-500 transition-colors"
              title="Edit"
            >
              <Pencil className="w-3 h-3" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onFileAction(fullPath, 'rename'); }}
              className="p-0.5 text-slate-400 hover:text-amber-500 transition-colors"
              title="Rename"
            >
              <MoreHorizontal className="w-3 h-3" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onFileAction(fullPath, 'delete'); }}
              className="p-0.5 text-slate-400 hover:text-red-500 transition-colors"
              title="Delete"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      {isDir && isExpanded && node.children && (
        <div>
          {sortNodes(node.children).map((child) => (
            <TreeNode
              key={child.name}
              node={child}
              depth={depth + 1}
              parentPath={fullPath}
              onFileClick={onFileClick}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              toggleExpand={toggleExpand}
              searchQuery={searchQuery}
              showStatus={showStatus}
              fileStatuses={fileStatuses}
              onFileAction={onFileAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Sort: dirs first, then alphabetically ---

function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// --- Main Component ---

export const FileTree = memo(function FileTree({
  nodes,
  onFileClick,
  selectedPath,
  className,
  showSearch = false,
  maxHeight = '400px',
  showStatus = false,
  fileStatuses,
  onFileAction,
}: FileTreeProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');

  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const filteredNodes = useMemo(() => filterTree(nodes, searchQuery), [nodes, searchQuery]);
  const totalFiles = useMemo(() => countFiles(nodes), [nodes]);

  return (
    <div className={cn('rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          File Explorer
        </span>
        <div className="flex items-center gap-2">
          {showStatus && fileStatuses && Object.keys(fileStatuses).length > 0 && (
            <div className="flex items-center gap-1.5">
              {(['added', 'modified', 'deleted'] as FileStatus[]).map((status) => {
                const count = Object.values(fileStatuses).filter((s) => s === status).length;
                if (count === 0) return null;
                const cfg = FILE_STATUS_CONFIG[status];
                return (
                  <span key={status} className={cn('text-[10px] flex items-center gap-0.5', cfg.color)}>
                    <span className={cn('w-1.5 h-1.5 rounded-full', cfg.dotColor)} />
                    {count}
                  </span>
                );
              })}
            </div>
          )}
          <span className="text-[10px] text-slate-400 tabular-nums">
            {totalFiles} file{totalFiles !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Search */}
      {showSearch && (
        <div className="px-2 py-1.5 border-b border-slate-200 dark:border-slate-700">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-400" />
            <input
              type="text"
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-6 pr-2 py-1 text-xs bg-transparent text-slate-700 dark:text-slate-300 placeholder:text-slate-400 focus:outline-none"
            />
          </div>
        </div>
      )}

      {/* Tree */}
      <div className="overflow-y-auto py-1" style={{ maxHeight }}>
        {filteredNodes.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-4">
            {searchQuery ? 'No matching files' : 'No files'}
          </p>
        ) : (
          sortNodes(filteredNodes).map((node) => (
            <TreeNode
              key={node.name}
              node={node}
              depth={0}
              parentPath=""
              onFileClick={onFileClick}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              toggleExpand={toggleExpand}
              searchQuery={searchQuery}
              showStatus={showStatus}
              fileStatuses={fileStatuses}
              onFileAction={onFileAction}
            />
          ))
        )}
      </div>
    </div>
  );
});
