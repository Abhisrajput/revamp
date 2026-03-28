'use client';

import { memo, useCallback, useMemo, useRef } from 'react';
import Editor, { Monaco } from '@monaco-editor/react';
import { useTheme } from 'next-themes';

interface CodeEditorProps {
  value?: string;
  onChange?: (value: string | undefined) => void;
  language?: string;
  readOnly?: boolean;
  height?: string;
  theme?: 'light' | 'dark';
}

export const CodeEditor = memo(function CodeEditor({
  value = '',
  onChange,
  language = 'javascript',
  readOnly = false,
  height = '400px',
  theme,
}: CodeEditorProps) {
  const { theme: systemTheme } = useTheme();
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<Monaco | null>(null);

  const resolvedTheme = theme || (systemTheme === 'dark' ? 'dark' : 'light');

  const handleEditorMount = useCallback((editor: any, monaco: Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
  }, []);

  const handleEditorChange = useCallback((value: string | undefined) => {
    onChange?.(value);
  }, [onChange]);

  const editorOptions = useMemo(() => ({
    minimap: { enabled: false },
    fontSize: 13,
    lineNumbers: 'on' as const,
    scrollBeyondLastLine: false,
    readOnly,
    tabSize: 2,
    formatOnPaste: true,
    formatOnType: true,
    automaticLayout: true,
  }), [readOnly]);

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900">
      <Editor
        height={height}
        language={language}
        value={value}
        onChange={handleEditorChange}
        onMount={handleEditorMount}
        theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
        options={editorOptions}
      />
    </div>
  );
});
