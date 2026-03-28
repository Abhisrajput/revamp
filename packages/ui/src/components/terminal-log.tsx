/**
 * Terminal-style log viewer component
 * Displays logs in a terminal-like interface with syntax highlighting
 */

import React, { useEffect, useRef } from 'react';

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug' | 'success';
  message: string;
  context?: Record<string, unknown>;
}

export interface TerminalLogProps {
  logs: LogEntry[];
  height?: number; // pixels, default 400
  maxLines?: number; // default 1000
  showTimestamp?: boolean;
  showLevel?: boolean;
  className?: string;
  autoScroll?: boolean;
  filter?: (log: LogEntry) => boolean;
  onClear?: () => void;
}

const levelColors: Record<string, { bg: string; text: string; prefix: string }> = {
  info: { bg: 'bg-blue-900', text: 'text-blue-300', prefix: '[INFO]' },
  warn: { bg: 'bg-yellow-900', text: 'text-yellow-300', prefix: '[WARN]' },
  error: { bg: 'bg-red-900', text: 'text-red-300', prefix: '[ERROR]' },
  debug: { bg: 'bg-gray-700', text: 'text-gray-300', prefix: '[DEBUG]' },
  success: { bg: 'bg-green-900', text: 'text-green-300', prefix: '[OK]' },
};

export const TerminalLog: React.FC<TerminalLogProps> = ({
  logs,
  height = 400,
  maxLines = 1000,
  showTimestamp = true,
  showLevel = true,
  className = '',
  autoScroll = true,
  filter,
  onClear,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Limit logs to maxLines
  const displayLogs = logs.length > maxLines ? logs.slice(-maxLines) : logs;

  // Apply filter if provided
  const filteredLogs = filter ? displayLogs.filter(filter) : displayLogs;

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filteredLogs, autoScroll]);

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between bg-gray-800 px-4 py-2 rounded-t">
        <div className="text-gray-300 text-sm font-mono">
          Terminal ({filteredLogs.length}/{logs.length} logs)
        </div>
        {onClear && (
          <button
            onClick={onClear}
            className="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded"
          >
            Clear
          </button>
        )}
      </div>

      {/* Log container */}
      <div
        ref={scrollRef}
        style={{ height }}
        className="bg-gray-900 border border-gray-700 rounded-b overflow-y-auto font-mono text-sm"
      >
        {filteredLogs.length === 0 ? (
          <div className="text-gray-500 p-4">No logs to display</div>
        ) : (
          filteredLogs.map((log) => {
            const levelStyle = levelColors[log.level];

            return (
              <div
                key={log.id}
                className={`${levelStyle.text} px-4 py-1 border-l-4 ${levelStyle.bg}`}
              >
                <div className="flex gap-2">
                  {showTimestamp && (
                    <span className="text-gray-500 flex-shrink-0">
                      {log.timestamp}
                    </span>
                  )}

                  {showLevel && (
                    <span className="flex-shrink-0 font-bold">
                      {levelStyle.prefix}
                    </span>
                  )}

                  <span className="flex-grow break-words">{log.message}</span>
                </div>

                {log.context && Object.keys(log.context).length > 0 && (
                  <div className="ml-4 mt-1 text-gray-400 text-xs">
                    {Object.entries(log.context).map(([key, value]) => (
                      <div key={key}>
                        {key}: {JSON.stringify(value)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default TerminalLog;
