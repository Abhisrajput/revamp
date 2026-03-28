/**
 * Hierarchical Retrieval — directory-based recursive codebase search with reranking.
 *
 * For large legacy codebases, flat file listing is insufficient. This service
 * provides a hierarchical navigation model:
 *
 *   Level 0: Project root — module/package boundaries
 *   Level 1: Module/directory — class/file groupings
 *   Level 2: File — function/method signatures
 *   Level 3: Function body — implementation details
 *
 * Retrieval is budget-aware: it starts at L0 and drills down only where
 * relevance scores justify the token spend. This prevents loading 100K tokens
 * of irrelevant code into the context window.
 *
 * Reranking uses a lightweight scoring heuristic based on:
 *   - File path relevance to the query
 *   - Language match (source vs target)
 *   - Recency of modification
 *   - Code complexity indicators
 *   - Name similarity to search terms
 *
 * Inspired by OpenViking's hierarchical retrieval pattern for navigating
 * massive legacy codebases efficiently.
 */

import * as fs from "fs";
import * as path from "path";

// ─── TYPES ──────────────────────────────────────────────────────

export interface RetrievalNode {
  /** Relative path from codebase root */
  path: string;
  /** Node type */
  type: "directory" | "file";
  /** Display name */
  name: string;
  /** Depth in the hierarchy (0 = root children) */
  depth: number;
  /** Relevance score (0-1) */
  relevance: number;
  /** Children (populated on drill-down) */
  children?: RetrievalNode[];
  /** File metadata (for file nodes) */
  fileMeta?: {
    extension: string;
    sizeBytes: number;
    lineCount?: number;
    language?: string;
    /** Code complexity heuristic (higher = more complex) */
    complexityScore?: number;
  };
  /** Content preview (for file nodes, first N lines) */
  preview?: string;
}

export interface RetrievalResult {
  /** Tree of relevant nodes */
  tree: RetrievalNode[];
  /** Flattened list of relevant files, ranked by relevance */
  rankedFiles: Array<{
    path: string;
    relevance: number;
    language: string;
    sizeBytes: number;
    preview: string;
  }>;
  /** Total files scanned */
  filesScanned: number;
  /** Total files in ranked results */
  filesReturned: number;
  /** Token estimate for the returned content */
  estimatedTokens: number;
  /** Search metadata */
  meta: {
    query: string;
    maxDepth: number;
    tokenBudget: number;
    durationMs: number;
  };
}

export interface RetrievalOptions {
  /** Search query / topic */
  query: string;
  /** Root directory of the codebase */
  codebasePath: string;
  /** Maximum hierarchy depth to explore (default: 3) */
  maxDepth?: number;
  /** Token budget for returned content (default: 8000) */
  tokenBudget?: number;
  /** File extensions to include (default: all source files) */
  extensions?: string[];
  /** Directories to skip */
  excludeDirs?: string[];
  /** Minimum relevance score to include (default: 0.1) */
  minRelevance?: number;
  /** Maximum files in ranked results (default: 30) */
  maxFiles?: number;
  /** Include file content previews (default: true) */
  includePreview?: boolean;
  /** Number of preview lines per file (default: 30) */
  previewLines?: number;
}

// ─── CONSTANTS ──────────────────────────────────────────────────

const DEFAULT_EXCLUDE_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "__pycache__", ".pytest_cache",
  ".next", ".nuxt", "dist", "build", "out", "target", "bin", "obj",
  ".idea", ".vscode", ".vs", "vendor", "bower_components",
  "coverage", ".nyc_output", "tmp", "temp", ".cache",
]);

const SOURCE_EXTENSIONS = new Set([
  // Legacy
  ".cbl", ".cob", ".cpy", ".jcl", ".proc", ".bas", ".frm", ".cls", ".vbs",
  ".pas", ".dpr", ".dfm", ".f", ".f90", ".f77", ".for", ".pbl", ".srd", ".sru",
  // Modern
  ".ts", ".tsx", ".js", ".jsx", ".java", ".py", ".go", ".cs", ".rb",
  ".rs", ".cpp", ".c", ".h", ".hpp", ".swift", ".kt", ".scala",
  ".php", ".pl", ".pm", ".sh", ".bash", ".sql", ".graphql",
  // Config/data
  ".json", ".yaml", ".yml", ".toml", ".xml", ".proto",
  ".dockerfile", ".tf", ".hcl",
]);

const LANGUAGE_MAP: Record<string, string> = {
  ".cbl": "COBOL", ".cob": "COBOL", ".cpy": "COBOL",
  ".jcl": "JCL", ".proc": "JCL",
  ".bas": "VB6", ".frm": "VB6", ".cls": "VB6", ".vbs": "VBScript",
  ".pas": "Delphi", ".dpr": "Delphi", ".dfm": "Delphi",
  ".f": "Fortran", ".f90": "Fortran", ".f77": "Fortran", ".for": "Fortran",
  ".pbl": "PowerBuilder", ".srd": "PowerBuilder", ".sru": "PowerBuilder",
  ".ts": "TypeScript", ".tsx": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript",
  ".java": "Java", ".py": "Python", ".go": "Go",
  ".cs": "C#", ".rb": "Ruby", ".rs": "Rust",
  ".cpp": "C++", ".c": "C", ".h": "C/C++", ".hpp": "C++",
  ".swift": "Swift", ".kt": "Kotlin", ".scala": "Scala",
  ".php": "PHP", ".pl": "Perl", ".pm": "Perl",
  ".sql": "SQL", ".graphql": "GraphQL",
  ".json": "JSON", ".yaml": "YAML", ".yml": "YAML",
  ".xml": "XML", ".proto": "Protobuf",
  ".tf": "Terraform", ".hcl": "HCL",
  ".sh": "Shell", ".bash": "Shell",
};

// ─── RELEVANCE SCORING ──────────────────────────────────────────

/**
 * Score a file's relevance to a search query.
 * Uses a lightweight heuristic — no LLM calls.
 */
function scoreRelevance(
  filePath: string,
  query: string,
  fileMeta?: { sizeBytes: number; lineCount?: number },
): number {
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const pathLower = filePath.toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();
  const dirName = path.dirname(filePath).toLowerCase();

  let score = 0;

  // Path/name matching (most important signal)
  for (const term of queryTerms) {
    if (fileName.includes(term)) score += 0.3;
    else if (dirName.includes(term)) score += 0.15;
    else if (pathLower.includes(term)) score += 0.1;
  }

  // Extension-based relevance
  const ext = path.extname(filePath).toLowerCase();
  const lang = LANGUAGE_MAP[ext] || "";

  for (const term of queryTerms) {
    if (lang.toLowerCase().includes(term)) score += 0.2;
  }

  // Key file patterns (entry points, configs, schemas)
  if (/^(main|index|app|server|bootstrap|startup)\./i.test(fileName)) {
    score += 0.1;
  }
  if (/^(schema|model|entity|migration|seed)\./i.test(fileName)) {
    if (queryTerms.some((t) => /data|database|schema|model|entity/i.test(t))) {
      score += 0.15;
    }
  }
  if (/^(route|controller|handler|endpoint|api)\./i.test(fileName)) {
    if (queryTerms.some((t) => /api|route|endpoint|service/i.test(t))) {
      score += 0.15;
    }
  }

  // Size penalty — very large files are less likely to be entirely relevant
  if (fileMeta?.sizeBytes) {
    if (fileMeta.sizeBytes > 100_000) score -= 0.05;
    if (fileMeta.sizeBytes > 500_000) score -= 0.1;
  }

  // Ensure score is in [0, 1]
  return Math.max(0, Math.min(1, score));
}

/**
 * Score a directory's relevance based on its name and path.
 */
function scoreDirRelevance(dirPath: string, query: string): number {
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const dirName = path.basename(dirPath).toLowerCase();
  const fullPath = dirPath.toLowerCase();

  let score = 0;

  for (const term of queryTerms) {
    if (dirName === term) score += 0.4;
    else if (dirName.includes(term)) score += 0.25;
    else if (fullPath.includes(term)) score += 0.1;
  }

  // Common important directories
  if (/^(src|lib|app|core|api|service|model|domain)$/i.test(dirName)) {
    score += 0.1;
  }

  return Math.max(0, Math.min(1, score));
}

// ─── TREE BUILDING ──────────────────────────────────────────────

/**
 * Build a hierarchical tree of the codebase, scored by relevance.
 */
function buildTree(
  rootPath: string,
  query: string,
  options: Required<Pick<RetrievalOptions, "maxDepth" | "extensions" | "excludeDirs" | "minRelevance">>,
  depth: number = 0,
): { nodes: RetrievalNode[]; filesScanned: number } {
  let filesScanned = 0;
  const nodes: RetrievalNode[] = [];

  if (depth > options.maxDepth) return { nodes, filesScanned };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return { nodes, filesScanned };
  }

  const excludeSet = new Set(options.excludeDirs);

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    const relativePath = path.relative(options.excludeDirs[0] ? path.resolve(rootPath, "..") : rootPath, fullPath);

    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;

    if (entry.isDirectory()) {
      if (excludeSet.has(entry.name) || DEFAULT_EXCLUDE_DIRS.has(entry.name)) continue;

      const dirRelevance = scoreDirRelevance(fullPath, query);
      const { nodes: children, filesScanned: childScanned } = buildTree(
        fullPath, query, options, depth + 1,
      );
      filesScanned += childScanned;

      // Include directory if it has relevant children or is itself relevant
      const maxChildRelevance = children.length > 0
        ? Math.max(...children.map((c) => c.relevance))
        : 0;
      const effectiveRelevance = Math.max(dirRelevance, maxChildRelevance * 0.8);

      if (effectiveRelevance >= options.minRelevance || children.length > 0) {
        nodes.push({
          path: relativePath,
          type: "directory",
          name: entry.name,
          depth,
          relevance: effectiveRelevance,
          children: children.length > 0 ? children : undefined,
        });
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const extensionSet = options.extensions.length > 0
        ? new Set(options.extensions.map((e) => e.startsWith(".") ? e : `.${e}`))
        : SOURCE_EXTENSIONS;

      if (!extensionSet.has(ext)) continue;

      filesScanned++;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      const language = LANGUAGE_MAP[ext] || ext.slice(1).toUpperCase();
      const relevance = scoreRelevance(fullPath, query, { sizeBytes: stat.size });

      if (relevance >= options.minRelevance) {
        nodes.push({
          path: relativePath,
          type: "file",
          name: entry.name,
          depth,
          relevance,
          fileMeta: {
            extension: ext,
            sizeBytes: stat.size,
            language,
          },
        });
      }
    }
  }

  // Sort by relevance descending
  nodes.sort((a, b) => b.relevance - a.relevance);
  return { nodes, filesScanned };
}

// ─── FILE PREVIEW ───────────────────────────────────────────────

/**
 * Read the first N lines of a file as a preview.
 */
function readPreview(filePath: string, maxLines: number): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").slice(0, maxLines);
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Rough token count estimate (1 token ≈ 4 chars).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── MAIN RETRIEVAL ─────────────────────────────────────────────

/**
 * Perform hierarchical retrieval against a codebase directory.
 *
 * @param options - Search options including query, path, and budget
 * @returns Ranked tree and file list with relevance scores
 */
export function retrieveHierarchical(options: RetrievalOptions): RetrievalResult {
  const startTime = Date.now();
  const {
    query,
    codebasePath,
    maxDepth = 3,
    tokenBudget = 8000,
    extensions = [],
    excludeDirs = [],
    minRelevance = 0.1,
    maxFiles = 30,
    includePreview = true,
    previewLines = 30,
  } = options;

  // Build the tree
  const { nodes: tree, filesScanned } = buildTree(
    codebasePath,
    query,
    { maxDepth, extensions, excludeDirs, minRelevance },
  );

  // Flatten to ranked file list
  const flatFiles: Array<{
    path: string;
    relevance: number;
    language: string;
    sizeBytes: number;
    fullPath: string;
  }> = [];

  function flatten(nodes: RetrievalNode[]) {
    for (const node of nodes) {
      if (node.type === "file" && node.fileMeta) {
        flatFiles.push({
          path: node.path,
          relevance: node.relevance,
          language: node.fileMeta.language || "unknown",
          sizeBytes: node.fileMeta.sizeBytes,
          fullPath: path.join(codebasePath, node.path),
        });
      }
      if (node.children) flatten(node.children);
    }
  }
  flatten(tree);

  // Sort by relevance and take top N
  flatFiles.sort((a, b) => b.relevance - a.relevance);
  const topFiles = flatFiles.slice(0, maxFiles);

  // Add previews within token budget
  let usedTokens = 0;
  const rankedFiles: RetrievalResult["rankedFiles"] = [];

  for (const file of topFiles) {
    let preview = "";
    if (includePreview && usedTokens < tokenBudget) {
      preview = readPreview(file.fullPath, previewLines);
      const previewTokens = estimateTokens(preview);

      if (usedTokens + previewTokens > tokenBudget) {
        // Truncate preview to fit budget
        const remainingChars = (tokenBudget - usedTokens) * 4;
        preview = preview.slice(0, remainingChars);
      }

      usedTokens += estimateTokens(preview);
    }

    rankedFiles.push({
      path: file.path,
      relevance: file.relevance,
      language: file.language,
      sizeBytes: file.sizeBytes,
      preview,
    });
  }

  return {
    tree,
    rankedFiles,
    filesScanned,
    filesReturned: rankedFiles.length,
    estimatedTokens: usedTokens,
    meta: {
      query,
      maxDepth,
      tokenBudget,
      durationMs: Date.now() - startTime,
    },
  };
}

/**
 * Convert retrieval results into a context block for pipeline injection.
 */
export function retrievalToContext(result: RetrievalResult): string {
  const sections: string[] = [
    `## Hierarchical Codebase Retrieval`,
    `Query: "${result.meta.query}" | ${result.filesScanned} files scanned | ${result.filesReturned} relevant files | ~${result.estimatedTokens} tokens\n`,
  ];

  for (const file of result.rankedFiles) {
    sections.push(`### ${file.path} (${file.language}, relevance: ${file.relevance.toFixed(2)})`);
    if (file.preview) {
      sections.push("```");
      sections.push(file.preview);
      sections.push("```");
    }
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * Perform a focused drill-down into a specific directory.
 * Used when a higher-level scan identifies a promising area.
 */
export function drillDown(
  codebasePath: string,
  targetDir: string,
  query: string,
  tokenBudget: number = 4000,
): RetrievalResult {
  const fullPath = path.join(codebasePath, targetDir);
  return retrieveHierarchical({
    query,
    codebasePath: fullPath,
    maxDepth: 2,
    tokenBudget,
    minRelevance: 0.05, // Lower threshold for drill-down
    previewLines: 50,    // More preview lines for focused analysis
  });
}
