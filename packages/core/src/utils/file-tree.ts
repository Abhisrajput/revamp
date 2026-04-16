export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  language?: string;
  size?: number;
}

const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', go: 'go', java: 'java', rs: 'rust', rb: 'ruby',
  cs: 'csharp', sql: 'sql', yaml: 'yaml', yml: 'yaml', json: 'json',
  md: 'markdown', html: 'html', css: 'css', scss: 'scss',
  sh: 'shell', bash: 'shell', dockerfile: 'dockerfile',
  xml: 'xml', toml: 'toml', tf: 'hcl',
};

/**
 * Infer the editor language from a filename's extension.
 */
export function inferLanguage(filename: string | undefined): string {
  if (!filename) return 'plaintext';
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return LANGUAGE_MAP[ext] || 'plaintext';
}

/**
 * Build a nested FileNode tree from a flat list of files with paths.
 * Each file must have a `path` property (e.g. "src/main/App.java").
 * Optionally override the language for all leaf nodes (e.g. 'gherkin').
 */
export function buildFileTree(
  files: { path: string }[],
  defaultLanguage?: string,
): FileNode[] {
  const root: FileNode[] = [];

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        current.push({
          name: part,
          type: 'file',
          path: file.path,
          ...(defaultLanguage ? { language: defaultLanguage } : {}),
        });
      } else {
        let dir = current.find((n) => n.name === part && n.type === 'directory');
        if (!dir) {
          dir = { name: part, type: 'directory', path: parts.slice(0, i + 1).join('/'), children: [] };
          current.push(dir);
        }
        current = dir.children!;
      }
    }
  }

  return root;
}
