/**
 * Shared validation utilities — ported from legacy-bridge deterministicChecks.ts
 *
 * These helpers are used across multiple deterministic checks for
 * text analysis, keyword extraction, and code-fence processing.
 */

// ─── STOPWORDS ───────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'this', 'that',
  'these', 'those', 'it', 'its', 'i', 'we', 'you', 'he', 'she', 'they',
  'me', 'us', 'him', 'her', 'them', 'my', 'our', 'your', 'his', 'their',
  'not', 'no', 'nor', 'as', 'if', 'then', 'else', 'when', 'up', 'out',
  'so', 'than', 'too', 'very', 'just', 'also', 'each', 'all', 'any',
  'both', 'few', 'more', 'most', 'other', 'some', 'such', 'only',
  'own', 'same', 'into', 'about', 'over', 'after', 'before', 'between',
  'under', 'during', 'through', 'above', 'below', 'which', 'who',
  'whom', 'what', 'where', 'how', 'why', 'while', 'there', 'here',
  'use', 'used', 'using', 'make', 'made', 'new', 'well', 'way',
  'get', 'set', 'see', 'need', 'take', 'know', 'let', 'like',
]);

// ─── KEY TERM EXTRACTION ─────────────────────────────────────────

/**
 * Extract the top-N meaningful key terms from text by frequency.
 * Filters stopwords, short words, and pure numbers.
 * Used by scoreCrossStageReferences to auto-generate prior-stage keywords.
 *
 * Ported from legacy-bridge deterministicChecks.ts extractKeyTerms()
 */
export function extractKeyTerms(text: string, topN = 30): string[] {
  if (!text || text.length < 20) return [];

  // Strip code fences to avoid noise from code identifiers
  const cleaned = stripCodeFences(text);

  // Tokenize: word boundary split, lowercase, filter
  const words = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

  // Count frequencies
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  // Sort by frequency descending, take topN
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}

// ─── CODE FENCE UTILITIES ─────────────────────────────────────────

/**
 * Remove fenced code blocks from markdown text.
 * Useful for analyzing prose content without code noise,
 * or for finding file paths in narrative text only.
 *
 * Ported from legacy-bridge deterministicChecks.ts stripCodeFences()
 */
export function stripCodeFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

/**
 * Extract all fenced code blocks from markdown.
 * Returns language, content, and line count for each block.
 */
export function extractCodeBlocks(
  text: string,
): Array<{ lang: string; content: string; lines: number; filename?: string }> {
  const blocks: Array<{ lang: string; content: string; lines: number; filename?: string }> = [];
  const pattern = /```(\w*)\s*([\w/.\\-]*\.\w+)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    blocks.push({
      lang: (match[1] || 'plain').toLowerCase(),
      filename: match[2] || undefined,
      content: match[3],
      lines: match[3].split('\n').length,
    });
  }

  return blocks;
}

// ─── PATH UTILITIES ─────────────────────────────────────────────

/**
 * Clean a file path string: trim quotes, trailing commas, etc.
 */
export function cleanPath(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[,;]+$/, '')
    .trim();
}

/**
 * Check if a string looks like a file path (has extension and path separators).
 */
export function isFilePath(str: string): boolean {
  const cleaned = cleanPath(str);
  return /^[\w@./\\-]+\.\w{1,10}$/.test(cleaned) && cleaned.length < 200;
}

// ─── IMPORT RESOLUTION ──────────────────────────────────────────

const EXTENSION_GUESSES = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.rs'];

/**
 * Extract relative import paths from code and check if they resolve
 * to generated file artifacts in the output.
 *
 * Returns { total, resolved, unresolved } for scoring import consistency.
 *
 * Ported from legacy-bridge's scoreBuildReadiness import resolution logic.
 */
export function checkImportConsistency(
  codeBlocks: Array<{ content: string; filename?: string }>,
  knownFiles: string[],
): { total: number; resolved: number; unresolved: string[] } {
  const relativeImports: string[] = [];

  for (const block of codeBlocks) {
    // ES imports: import ... from './foo'
    const esImports = block.content.matchAll(/(?:import|from)\s+['"](\.[^'"]+)['"]/g);
    for (const m of esImports) {
      relativeImports.push(m[1]);
    }

    // CommonJS: require('./foo')
    const cjsImports = block.content.matchAll(/require\(['"](\.[^'"]+)['"]\)/g);
    for (const m of cjsImports) {
      relativeImports.push(m[1]);
    }

    // Go: relative package references (simplified)
    const goImports = block.content.matchAll(/import\s+['"]\.\/([^'"]+)['"]/g);
    for (const m of goImports) {
      relativeImports.push(`./${m[1]}`);
    }
  }

  const uniqueImports = [...new Set(relativeImports)];
  const knownLower = new Set(knownFiles.map((f) => f.toLowerCase()));
  const unresolved: string[] = [];

  for (const imp of uniqueImports) {
    const base = imp.replace(/^\.\//, '');
    // Try exact match first
    if (knownLower.has(base.toLowerCase()) || knownLower.has(imp.toLowerCase())) {
      continue;
    }
    // Try with extensions
    let found = false;
    for (const ext of EXTENSION_GUESSES) {
      if (knownLower.has(`${base}${ext}`.toLowerCase()) || knownLower.has(`${base}/index${ext}`.toLowerCase())) {
        found = true;
        break;
      }
    }
    if (!found) {
      unresolved.push(imp);
    }
  }

  return {
    total: uniqueImports.length,
    resolved: uniqueImports.length - unresolved.length,
    unresolved,
  };
}
