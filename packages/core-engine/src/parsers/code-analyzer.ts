/**
 * Code analysis utilities
 */

export interface ComplexityScore {
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  halsteadComplexity: number;
  linesOfCode: number;
}

export interface DependencyInfo {
  name: string;
  version?: string;
  type: 'direct' | 'transitive';
  isDev: boolean;
  hasVulnerabilities: boolean;
}

/**
 * Extract imports/requires from code
 */
export function extractDependencies(
  content: string,
  language: string,
): string[] {
  const dependencies: string[] = [];
  let match: RegExpExecArray | null;

  if (language === 'JavaScript' || language === 'TypeScript') {
    // Extract require() calls
    const requirePattern = /require\(['"]([^'"]+)['"]\)/g;
    while ((match = requirePattern.exec(content)) !== null) {
      dependencies.push(match[1]);
    }

    // Extract import statements
    const importPattern = /import\s+(?:{[^}]*}|[\w*\s,]+)\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = importPattern.exec(content)) !== null) {
      dependencies.push(match[1]);
    }
  } else if (language === 'Python') {
    // Extract import statements
    const importPattern = /(?:^|\n)import\s+([\w.]+)|from\s+([\w.]+)\s+import/gm;
    while ((match = importPattern.exec(content)) !== null) {
      dependencies.push(match[1] || match[2]);
    }
  } else if (language === 'Java') {
    // Extract import statements
    const importPattern = /import\s+([\w.]+);/g;
    while ((match = importPattern.exec(content)) !== null) {
      dependencies.push(match[1]);
    }
  } else if (language === 'Go') {
    // Extract import statements
    const importPattern = /import\s+[({]?\s*"([^"]+)"/g;
    while ((match = importPattern.exec(content)) !== null) {
      dependencies.push(match[1]);
    }
  }

  // Remove duplicates
  return [...new Set(dependencies)];
}

/**
 * Calculate complexity score from code
 */
export function calculateComplexity(
  content: string,
  language: string,
): ComplexityScore {
  const lines = content.split('\n');
  const codeLines = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('#');
  });

  let cyclomaticComplexity = 1; // Base complexity
  let cognitiveComplexity = 0;
  let nestingLevel = 0;
  let maxNesting = 0;

  // Count control flow statements
  const controlPatterns = [
    /\b(if|else if|else|switch|case|default)\b/g,
    /\b(for|while|do)\b/g,
    /\b(try|catch|finally)\b/g,
    /\b(&&|\|\||!)\b/g,
  ];

  for (const pattern of controlPatterns) {
    const matches = content.match(pattern) || [];
    cyclomaticComplexity += matches.length;
    cognitiveComplexity += matches.length;
  }

  // Estimate nesting level
  const braceMatches = content.match(/{/g) || [];
  const parenMatches = content.match(/\(/g) || [];
  nestingLevel = Math.max(braceMatches.length, parenMatches.length);
  maxNesting = Math.ceil(nestingLevel / 10);

  // Calculate Halstead complexity (simplified)
  const uniqueTokens = new Set(content.match(/\w+/g) || []).size;
  const totalTokens = (content.match(/\w+/g) || []).length;
  const halsteadComplexity = uniqueTokens > 0 ? Math.log2(uniqueTokens) : 0;

  return {
    cyclomaticComplexity: Math.min(cyclomaticComplexity, 50), // Cap at 50
    cognitiveComplexity: cognitiveComplexity + maxNesting,
    halsteadComplexity,
    linesOfCode: codeLines.length,
  };
}
