/**
 * File Analyzer Service — scans a codebase to extract structure, metrics,
 * and representative code snippets for the SCAN pipeline stage.
 *
 * Supports three source types:
 *   - 'local'  → reads directly from a filesystem path
 *   - 'git'    → shallow-clones a repo to a temp dir, then reads it
 *   - 'upload' → reads from an uploaded/extracted directory (S3 path or local)
 */

import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';

// ─── TYPES ──────────────────────────────────────────────────────

export interface FileAnalysisResult {
  totalFiles: number;
  totalLines: number;
  /** File count by extension, e.g. { "java": 120, "xml": 15 } */
  filesByExtension: Record<string, number>;
  /** Lines of code by extension */
  linesByExtension: Record<string, number>;
  /** Top 10 largest files */
  largestFiles: Array<{ path: string; lines: number; extension: string }>;
  /** ASCII directory tree (truncated) */
  directoryTree: string;
  /** Key files: entry points, configs, build files */
  keyFiles: string[];
  /** Sample code snippets from representative files */
  codeSnippets: Array<{ path: string; language: string; content: string }>;
  /** Detected languages ranked by LOC */
  detectedLanguages: string[];
  /** Path to the cloned/analyzed codebase on disk (for artifact storage) */
  codebasePath?: string;
  /** Structured folder tree for UI rendering */
  folderStructure: Array<{ name: string; type: 'dir' | 'file'; children?: any[] }>;
  /** AST-based code skeletons for key source files (token-efficient structural summaries) */
  codeSkeletons?: string;
  /** Skeleton extraction stats */
  skeletonStats?: { supportedFiles: number; unsupportedFiles: number; tokensSaved: number };
  /** Framework/runtime versions extracted from config files (composer.json, package.json, pom.xml, etc.) */
  frameworkVersions?: Array<{ name: string; version: string; source: string }>;
  /** Migration/schema file stats */
  migrationStats?: { count: number; earliest: string; latest: string; directory: string };
  /** Component counts by directory (controllers, models, etc.) */
  componentCounts?: Array<{ name: string; directory: string; count: number }>;
}

// ─── CONSTANTS ──────────────────────────────────────────────────

/** Extensions to classify as source code (not config/docs/binary) */
const SOURCE_EXTENSIONS = new Set([
  // Legacy
  'cbl', 'cob', 'cpy', 'jcl', 'pli', 'rpg', 'rpgle', 'cls', 'frm', 'bas',
  'pas', 'dfm', 'dpr', 'f', 'f90', 'for', 'pbl', 'pbt',
  // Modern
  'java', 'kt', 'scala', 'py', 'go', 'rs', 'cs', 'fs',
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs',
  'rb', 'php', 'swift', 'm', 'mm', 'c', 'cpp', 'h', 'hpp',
  'sql', 'plsql', 'pgsql',
  'sh', 'bash', 'ps1', 'bat', 'cmd',
  'r', 'lua', 'ex', 'exs', 'erl', 'hrl', 'clj', 'hs',
]);

const CONFIG_EXTENSIONS = new Set([
  'xml', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'properties', 'env', 'gradle', 'sbt', 'pom',
]);

const DOCS_EXTENSIONS = new Set([
  'md', 'txt', 'rst', 'adoc', 'html', 'htm', 'css',
]);

/** Directories to always skip */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'vendor', '__pycache__',
  '.tox', '.venv', 'venv', 'env', '.env', 'dist', 'build', 'out',
  'target', '.gradle', '.idea', '.vscode', '.next', '.nuxt',
  'bin', 'obj', 'packages', 'bower_components',
]);

/** Binary extensions to skip entirely */
const BINARY_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'class', 'jar', 'war', 'ear',
  'zip', 'tar', 'gz', 'rar', '7z',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'svg', 'webp',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'mp3', 'mp4', 'avi', 'mov', 'wav',
  'db', 'sqlite', 'mdb',
]);

/** Display names for extensions */
const LANG_NAMES: Record<string, string> = {
  cbl: 'COBOL', cob: 'COBOL', cpy: 'COBOL Copybook',
  jcl: 'JCL', pli: 'PL/I', rpg: 'RPG', rpgle: 'RPG/LE',
  cls: 'VB6 Class', frm: 'VB6 Form', bas: 'VB/BASIC',
  pas: 'Pascal/Delphi', dfm: 'Delphi Form', dpr: 'Delphi Project',
  f: 'Fortran', f90: 'Fortran 90', for: 'Fortran',
  pbl: 'PowerBuilder', pbt: 'PowerBuilder',
  java: 'Java', kt: 'Kotlin', scala: 'Scala',
  py: 'Python', go: 'Go', rs: 'Rust',
  js: 'JavaScript', ts: 'TypeScript', jsx: 'JSX', tsx: 'TSX',
  cs: 'C#', fs: 'F#', rb: 'Ruby', php: 'PHP',
  sql: 'SQL', plsql: 'PL/SQL', pgsql: 'pgSQL',
  sh: 'Shell', bash: 'Bash', ps1: 'PowerShell',
  xml: 'XML', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  toml: 'TOML', properties: 'Properties',
};

const MAX_FILES = 5000; // safety cap
const MAX_SNIPPET_LINES = 60; // lines per snippet
const MAX_SNIPPETS = 5; // snippets included
const TREE_MAX_DEPTH = 4;
const TREE_MAX_ENTRIES = 80;

// ─── MAIN ENTRY POINT ──────────────────────────────────────────

export async function analyzeCodebase(
  sourceType: string,
  sourceUrl: string,
  sourceBranch?: string,
  accessToken?: string,
): Promise<FileAnalysisResult> {
  let dirPath: string;

  switch (sourceType) {
    case 'local':
      dirPath = sourceUrl;
      break;

    case 'git':
      const tmpDir = path.join(os.tmpdir(), `revamp-scan-${Date.now()}`);
      // Build the clone URL — inject access token for private repos
      let cloneUrl = sourceUrl;
      if (accessToken && cloneUrl.startsWith('https://')) {
        // Insert token into HTTPS URL: https://TOKEN@github.com/...
        cloneUrl = cloneUrl.replace('https://', `https://${accessToken}@`);
      }
      const safeBranch = (sourceBranch || 'main').replace(/[^a-zA-Z0-9._\-\/]/g, '');
      try {
        execSync(
          `git clone --depth 1 --single-branch --branch "${safeBranch}" "${cloneUrl}" "${tmpDir}"`,
          { timeout: 120_000, stdio: 'pipe' },
        );
      } catch (err: any) {
        // Try without branch specification (default branch)
        try {
          execSync(
            `git clone --depth 1 "${cloneUrl}" "${tmpDir}"`,
            { timeout: 120_000, stdio: 'pipe' },
          );
        } catch {
          // Sanitize error message to avoid leaking the access token
          const safeMessage = err.message?.replace(accessToken || '', '***') || 'Unknown error';
          throw new Error(`Failed to clone repository: ${safeMessage}`);
        }
      }
      dirPath = tmpDir;
      // NOTE: we no longer delete the cloned repo here — it's kept as an artifact
      // for use by later pipeline stages. Cleanup is handled by the pipeline service.
      break;

    case 'upload':
      // For uploaded files, source_url points to the extracted directory
      dirPath = sourceUrl;
      break;

    default:
      throw new Error(`Unsupported source type: ${sourceType}`);
  }

  // Verify directory exists
  const stat = await fs.stat(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Source path is not a directory: ${dirPath}`);
  }

  const result = await scanDirectory(dirPath);
  // Attach the codebase path so the pipeline service can reference it later
  result.codebasePath = dirPath;
  // Extract framework/runtime versions from config files
  result.frameworkVersions = await extractFrameworkVersions(dirPath);
  // Extract migration stats and component counts
  result.migrationStats = await extractMigrationStats(dirPath);
  result.componentCounts = await extractComponentCounts(dirPath);
  return result;
}

/**
 * Extract framework and runtime versions from config files.
 * Dynamically detects the project type and reads the relevant config.
 * Works for ANY language/framework — not hardcoded to specific stacks.
 */
async function extractFrameworkVersions(dirPath: string): Promise<Array<{ name: string; version: string; source: string }>> {
  const versions: Array<{ name: string; version: string; source: string }> = [];

  const tryReadJson = async (filePath: string): Promise<any> => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch { return null; }
  };

  const tryReadFile = async (filePath: string): Promise<string | null> => {
    try { return await fs.readFile(filePath, 'utf-8'); } catch { return null; }
  };

  // PHP: composer.json — extract ALL dependencies (runtime + dev)
  const composer = await tryReadJson(path.join(dirPath, 'composer.json'));
  if (composer) {
    const reqProd = composer.require || {};
    const reqDev = composer['require-dev'] || {};
    if (reqProd.php) versions.push({ name: 'PHP', version: reqProd.php, source: 'composer.json' });
    for (const [pkg, ver] of Object.entries(reqProd)) {
      if (pkg === 'php' || pkg.startsWith('ext-')) continue;
      versions.push({ name: pkg, version: ver as string, source: 'composer.json' });
    }
    for (const [pkg, ver] of Object.entries(reqDev)) {
      if (pkg === 'php' || pkg.startsWith('ext-')) continue;
      versions.push({ name: `${pkg} (dev)`, version: ver as string, source: 'composer.json' });
    }
  }

  // Node.js: package.json — search root + common workspace locations
  const packageJsonPaths = [
    path.join(dirPath, 'package.json'),
    // Common workspace/asset locations for monorepos and Laravel projects
    ...await (async () => {
      try {
        const candidates = ['resources/assets/v2/package.json', 'resources/assets/v1/package.json',
          'frontend/package.json', 'client/package.json', 'src/package.json'];
        return candidates.map(c => path.join(dirPath, c));
      } catch { return []; }
    })(),
  ];

  for (const pkgPath of packageJsonPaths) {
    const pkg = await tryReadJson(pkgPath);
    if (!pkg) continue;
    const relPath = path.relative(dirPath, pkgPath);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (pkg.engines?.node) versions.push({ name: 'Node.js', version: pkg.engines.node, source: relPath });
    for (const [name, ver] of Object.entries(deps)) {
      // Skip meta-packages and internal workspace refs
      if (typeof ver !== 'string' || (ver as string).startsWith('workspace:') || (ver as string).startsWith('file:')) continue;
      versions.push({ name, version: ver as string, source: relPath });
    }
  }

  // Java: pom.xml
  const pom = await tryReadFile(path.join(dirPath, 'pom.xml'));
  if (pom) {
    const javaVersion = pom.match(/<java\.version>([^<]+)<\/java\.version>/)?.[1];
    const springVersion = pom.match(/<spring-boot\.version>([^<]+)<\/spring-boot\.version>/)?.[1]
      || pom.match(/<parent>[\s\S]*?<version>([^<]+)<\/version>/)?.[1];
    if (javaVersion) versions.push({ name: 'Java', version: javaVersion, source: 'pom.xml' });
    if (springVersion) versions.push({ name: 'Spring Boot', version: springVersion, source: 'pom.xml' });
  }

  // Java: build.gradle
  const gradle = await tryReadFile(path.join(dirPath, 'build.gradle'));
  if (gradle) {
    const javaVer = gradle.match(/sourceCompatibility\s*=\s*['"]?(\d+)/)?.[1];
    const springVer = gradle.match(/springBootVersion\s*=\s*['"]([^'"]+)/)?.[1]
      || gradle.match(/org\.springframework\.boot.*?:([^'"]+)/)?.[1];
    if (javaVer) versions.push({ name: 'Java', version: javaVer, source: 'build.gradle' });
    if (springVer) versions.push({ name: 'Spring Boot', version: springVer, source: 'build.gradle' });
  }

  // Python: pyproject.toml, setup.py, requirements.txt
  const pyproject = await tryReadFile(path.join(dirPath, 'pyproject.toml'));
  if (pyproject) {
    const pythonVer = pyproject.match(/requires-python\s*=\s*"([^"]+)"/)?.[1];
    if (pythonVer) versions.push({ name: 'Python', version: pythonVer, source: 'pyproject.toml' });
    const deps = pyproject.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)?.[1];
    if (deps) {
      for (const fw of ['django', 'flask', 'fastapi', 'sqlalchemy', 'celery', 'pydantic']) {
        const m = deps.match(new RegExp(`${fw}[><=~!]*([\\d.]+)`, 'i'));
        if (m) versions.push({ name: fw, version: m[1], source: 'pyproject.toml' });
      }
    }
  }

  // Go: go.mod
  const gomod = await tryReadFile(path.join(dirPath, 'go.mod'));
  if (gomod) {
    const goVer = gomod.match(/^go\s+(\d+\.\d+)/m)?.[1];
    if (goVer) versions.push({ name: 'Go', version: goVer, source: 'go.mod' });
  }

  // .NET: *.csproj
  const csproj = await tryReadFile(path.join(dirPath, '*.csproj'))
    || await (async () => {
      try {
        const files = await fs.readdir(dirPath);
        const cs = files.find(f => f.endsWith('.csproj'));
        return cs ? await fs.readFile(path.join(dirPath, cs), 'utf-8') : null;
      } catch { return null; }
    })();
  if (csproj) {
    const tfm = csproj.match(/<TargetFramework>([^<]+)/)?.[1];
    if (tfm) versions.push({ name: '.NET', version: tfm, source: '*.csproj' });
  }

  // Ruby: Gemfile
  const gemfile = await tryReadFile(path.join(dirPath, 'Gemfile'));
  if (gemfile) {
    const rubyVer = gemfile.match(/ruby\s+['"]([^'"]+)/)?.[1];
    const railsVer = gemfile.match(/gem\s+['"]rails['"],\s*['"]([^'"]+)/)?.[1];
    if (rubyVer) versions.push({ name: 'Ruby', version: rubyVer, source: 'Gemfile' });
    if (railsVer) versions.push({ name: 'Rails', version: railsVer, source: 'Gemfile' });
  }

  // Rust: Cargo.toml
  const cargo = await tryReadFile(path.join(dirPath, 'Cargo.toml'));
  if (cargo) {
    const edition = cargo.match(/edition\s*=\s*"(\d+)"/)?.[1];
    if (edition) versions.push({ name: 'Rust Edition', version: edition, source: 'Cargo.toml' });
  }

  return versions;
}

// ─── DIRECTORY SCANNER ──────────────────────────────────────────

interface FileEntry {
  relativePath: string;
  extension: string;
  lines: number;
  size: number;
}

async function scanDirectory(rootDir: string): Promise<FileAnalysisResult> {
  const files: FileEntry[] = [];

  // Recursive walk
  async function walk(dir: string, depth: number) {
    if (files.length >= MAX_FILES) return;
    if (depth > 15) return; // safety

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission denied, etc.
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;
        if (!ext) continue; // skip extensionless files

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(rootDir, fullPath);

        let lines = 0;
        let size = 0;
        try {
          const stat = await fs.stat(fullPath);
          size = stat.size;
          if (size > 2_000_000) continue; // skip files > 2MB

          const content = await fs.readFile(fullPath, 'utf-8');
          lines = content.split('\n').length;
        } catch {
          continue; // unreadable
        }

        files.push({ relativePath, extension: ext, lines, size });
      }
    }
  }

  await walk(rootDir, 0);

  // ─── Aggregate metrics ───────────────────────────────────────

  const filesByExtension: Record<string, number> = {};
  const linesByExtension: Record<string, number> = {};
  let totalLines = 0;

  for (const f of files) {
    filesByExtension[f.extension] = (filesByExtension[f.extension] || 0) + 1;
    linesByExtension[f.extension] = (linesByExtension[f.extension] || 0) + f.lines;
    totalLines += f.lines;
  }

  // ─── Largest files ───────────────────────────────────────────

  const largestFiles = [...files]
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 10)
    .map((f) => ({ path: f.relativePath, lines: f.lines, extension: f.extension }));

  // ─── Key files (entry points, configs, build files) ──────────

  const keyFilePatterns = [
    /^(main|index|app|server|program|application)\./i,
    /^(pom\.xml|build\.gradle|Makefile|CMakeLists\.txt|Cargo\.toml)$/i,
    /^(package\.json|go\.mod|requirements\.txt|Gemfile|setup\.py)$/,
    /^(dockerfile|docker-compose\.ya?ml)$/i,
    /^(\.env\.example|config\.(ts|js|py|yaml|yml|json))$/i,
    /^(schema\.(sql|prisma)|migration)/i,
  ];

  const keyFiles = files
    .filter((f) => keyFilePatterns.some((p) => p.test(path.basename(f.relativePath))))
    .map((f) => f.relativePath)
    .slice(0, 20);

  // ─── Directory tree ──────────────────────────────────────────

  const directoryTree = await buildDirectoryTree(rootDir, TREE_MAX_DEPTH, TREE_MAX_ENTRIES);

  // ─── Detected languages (by LOC, source code only) ──────────

  const sourceLangs = Object.entries(linesByExtension)
    .filter(([ext]) => SOURCE_EXTENSIONS.has(ext))
    .sort((a, b) => b[1] - a[1])
    .map(([ext]) => LANG_NAMES[ext] || ext.toUpperCase());

  // Deduplicate (e.g., COBOL from cbl and cob)
  const detectedLanguages = [...new Set(sourceLangs)];

  // ─── Code snippets from representative files ─────────────────

  const codeSnippets = await extractCodeSnippets(rootDir, files, largestFiles);

  // ─── AST-based code skeletonization ─────────────────────────
  // Extract structural skeletons from the top source files for token-efficient
  // representation. This dramatically reduces token usage when sending
  // codebase context to the LLM.
  let codeSkeletons: string | undefined;
  let skeletonStats: { supportedFiles: number; unsupportedFiles: number; tokensSaved: number } | undefined;

  try {
    const { skeletonizeFiles, skeletonsToDocument } = await import("@revamp/core-engine/src/parsers/ast-skeleton.js") as typeof import("@revamp/core-engine/src/parsers/ast-skeleton");

    // Read the top source files for skeletonization (largest files = most important)
    const skeletonCandidates = files
      .filter((f) => SOURCE_EXTENSIONS.has(f.extension) && f.lines > 20)
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 30); // top 30 files

    const fileContents: Array<{ path: string; content: string }> = [];
    for (const file of skeletonCandidates) {
      try {
        const fullPath = path.join(rootDir, file.relativePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        if (content.length < 500000) { // skip extremely large files
          fileContents.push({ path: file.relativePath, content });
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (fileContents.length > 0) {
      const result = skeletonizeFiles(fileContents);
      if (result.skeletons.length > 0) {
        codeSkeletons = skeletonsToDocument(result.skeletons);
        skeletonStats = {
          supportedFiles: result.supportedFiles,
          unsupportedFiles: result.unsupportedFiles,
          tokensSaved: result.totalTokensSaved,
        };
      }
    }
  } catch {
    // Skeletonization failure is non-fatal — proceed without it
  }

  // ─── Structured folder tree for UI ────────────────────────────

  const folderStructure = await buildFolderStructure(rootDir, TREE_MAX_DEPTH, TREE_MAX_ENTRIES);

  return {
    totalFiles: files.length,
    totalLines,
    filesByExtension,
    linesByExtension,
    largestFiles,
    directoryTree,
    keyFiles,
    codeSnippets,
    detectedLanguages,
    folderStructure,
    codeSkeletons,
    skeletonStats,
  };
}

// ─── TREE BUILDER ───────────────────────────────────────────────

async function buildDirectoryTree(
  rootDir: string,
  maxDepth: number,
  maxEntries: number,
): Promise<string> {
  const lines: string[] = [path.basename(rootDir) + '/'];
  let count = 0;

  async function walk(dir: string, prefix: string, depth: number) {
    if (depth >= maxDepth || count >= maxEntries) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort: directories first, then files
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    // Filter out skipped dirs
    entries = entries.filter((e) => {
      if (e.isDirectory() && (SKIP_DIRS.has(e.name) || e.name.startsWith('.'))) return false;
      if (e.isFile() && BINARY_EXTENSIONS.has(path.extname(e.name).slice(1).toLowerCase())) return false;
      return true;
    });

    for (let i = 0; i < entries.length; i++) {
      if (count >= maxEntries) {
        lines.push(`${prefix}└── ... (${entries.length - i} more)`);
        break;
      }

      const entry = entries[i];
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = prefix + (isLast ? '    ' : '│   ');

      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        count++;
        await walk(path.join(dir, entry.name), childPrefix, depth + 1);
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
        count++;
      }
    }
  }

  await walk(rootDir, '', 0);
  return lines.join('\n');
}

// ─── STRUCTURED FOLDER TREE BUILDER ─────────────────────────────

interface FolderNode {
  name: string;
  type: 'dir' | 'file';
  children?: FolderNode[];
}

async function buildFolderStructure(
  rootDir: string,
  maxDepth: number,
  maxEntries: number,
): Promise<FolderNode[]> {
  let count = 0;

  async function walk(dir: string, depth: number): Promise<FolderNode[]> {
    if (depth >= maxDepth || count >= maxEntries) return [];

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    entries = entries.filter((e) => {
      if (e.isDirectory() && (SKIP_DIRS.has(e.name) || e.name.startsWith('.'))) return false;
      if (e.isFile() && BINARY_EXTENSIONS.has(path.extname(e.name).slice(1).toLowerCase())) return false;
      return true;
    });

    const nodes: FolderNode[] = [];
    for (const entry of entries) {
      if (count >= maxEntries) break;
      count++;

      if (entry.isDirectory()) {
        const children = await walk(path.join(dir, entry.name), depth + 1);
        nodes.push({ name: entry.name + '/', type: 'dir', children });
      } else {
        nodes.push({ name: entry.name, type: 'file' });
      }
    }
    return nodes;
  }

  return walk(rootDir, 0);
}

// ─── CODE SNIPPET EXTRACTOR ────────────────────────────────────

async function extractCodeSnippets(
  rootDir: string,
  allFiles: FileEntry[],
  largestFiles: Array<{ path: string; lines: number; extension: string }>,
): Promise<Array<{ path: string; language: string; content: string }>> {
  const snippets: Array<{ path: string; language: string; content: string }> = [];

  // Pick representative files: a mix of largest source files + key entry points
  const candidates = largestFiles
    .filter((f) => SOURCE_EXTENSIONS.has(f.extension))
    .slice(0, MAX_SNIPPETS);

  // If we don't have enough source files from largest, find entry points
  if (candidates.length < MAX_SNIPPETS) {
    const entryPatterns = [/main\./i, /index\./i, /app\./i, /server\./i, /program\./i];
    for (const f of allFiles) {
      if (candidates.length >= MAX_SNIPPETS) break;
      if (!SOURCE_EXTENSIONS.has(f.extension)) continue;
      if (candidates.some((c) => c.path === f.relativePath)) continue;
      if (entryPatterns.some((p) => p.test(path.basename(f.relativePath)))) {
        candidates.push({ path: f.relativePath, lines: f.lines, extension: f.extension });
      }
    }
  }

  for (const file of candidates) {
    try {
      const fullPath = path.join(rootDir, file.path);
      const content = await fs.readFile(fullPath, 'utf-8');
      const fileLines = content.split('\n');

      // Take first MAX_SNIPPET_LINES lines (or less if file is smaller)
      const snippet = fileLines.slice(0, MAX_SNIPPET_LINES).join('\n');
      const lang = LANG_NAMES[file.extension] || file.extension;

      snippets.push({
        path: file.path,
        language: lang,
        content: snippet + (fileLines.length > MAX_SNIPPET_LINES ? `\n// ... (${fileLines.length - MAX_SNIPPET_LINES} more lines)` : ''),
      });
    } catch {
      // skip unreadable
    }
  }

  return snippets;
}

// ─── MIGRATION STATS ────────────────────────────────────────────

/**
 * Counts migration/schema files and extracts date range.
 * Dynamically detects the migration directory for any framework.
 */
async function extractMigrationStats(dirPath: string): Promise<FileAnalysisResult['migrationStats']> {
  const candidates = [
    'database/migrations',     // Laravel
    'db/migrate',              // Rails
    'migrations',              // Django, generic
    'src/migrations',          // TypeORM
    'prisma/migrations',       // Prisma
    'alembic/versions',        // Alembic (Python)
    'flyway/sql',              // Flyway (Java)
    'liquibase',               // Liquibase
  ];

  for (const candidate of candidates) {
    const migDir = path.join(dirPath, candidate);
    try {
      const stat = await fs.stat(migDir);
      if (!stat.isDirectory()) continue;

      const entries = await fs.readdir(migDir);
      const migFiles = entries.filter(f => /\.(php|rb|py|sql|ts|js)$/i.test(f)).sort();
      if (migFiles.length === 0) continue;

      return {
        count: migFiles.length,
        earliest: migFiles[0],
        latest: migFiles[migFiles.length - 1],
        directory: candidate,
      };
    } catch { /* dir doesn't exist */ }
  }

  return undefined;
}

// ─── COMPONENT COUNTS ───────────────────────────────────────────

/**
 * Counts source files in common component directories.
 * Dynamically discovers directories — works for any framework.
 */
async function extractComponentCounts(dirPath: string): Promise<FileAnalysisResult['componentCounts']> {
  // Common component directories across frameworks
  const candidates = [
    { name: 'Controllers', dirs: ['app/Http/Controllers', 'app/Api', 'src/controllers', 'app/controllers', 'Controllers'] },
    { name: 'Models', dirs: ['app/Models', 'src/models', 'app/models', 'Models', 'app/Entity'] },
    { name: 'Repositories', dirs: ['app/Repositories', 'src/repositories', 'app/repositories'] },
    { name: 'Services', dirs: ['app/Services', 'src/services', 'app/services'] },
    { name: 'Middleware', dirs: ['app/Http/Middleware', 'app/Api/V1/Middleware', 'src/middleware', 'app/middleware'] },
    { name: 'Views/Templates', dirs: ['resources/views', 'templates', 'src/views', 'app/views'] },
    { name: 'Migrations', dirs: ['database/migrations', 'db/migrate', 'migrations', 'prisma/migrations'] },
    { name: 'Tests', dirs: ['tests', 'test', 'spec', '__tests__', 'src/test'] },
    { name: 'Jobs/Workers', dirs: ['app/Jobs', 'src/jobs', 'app/workers'] },
    { name: 'Events', dirs: ['app/Events', 'src/events'] },
    { name: 'Providers', dirs: ['app/Providers', 'src/providers'] },
    { name: 'Factories', dirs: ['app/Factory', 'database/factories', 'src/factories'] },
    { name: 'Console Commands', dirs: ['app/Console/Commands', 'app/Console', 'src/commands'] },
  ];

  const counts: NonNullable<FileAnalysisResult['componentCounts']> = [];

  for (const candidate of candidates) {
    for (const dir of candidate.dirs) {
      const fullDir = path.join(dirPath, dir);
      try {
        const stat = await fs.stat(fullDir);
        if (!stat.isDirectory()) continue;

        const fileCount = await countFilesRecursive(fullDir);
        if (fileCount > 0) {
          counts.push({ name: candidate.name, directory: dir, count: fileCount });
          break; // use first matching dir for this component type
        }
      } catch { /* dir doesn't exist */ }
    }
  }

  return counts.length > 0 ? counts : undefined;
}

async function countFilesRecursive(dir: string, depth = 0): Promise<number> {
  if (depth > 10) return 0;
  let count = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isFile() && /\.(php|rb|py|ts|js|java|go|rs|cs|vue|jsx|tsx)$/i.test(entry.name)) {
        count++;
      } else if (entry.isDirectory()) {
        count += await countFilesRecursive(path.join(dir, entry.name), depth + 1);
      }
    }
  } catch { /* permission error */ }
  return count;
}
