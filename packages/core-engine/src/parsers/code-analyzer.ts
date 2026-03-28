/**
 * Code analysis utilities
 */

export interface LanguageDetectionResult {
  language: string;
  confidence: number;
  extensions: string[];
  mimeTypes: string[];
}

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

export interface CodeMetrics {
  totalLines: number;
  blankLines: number;
  commentLines: number;
  codeLines: number;
  commentRatio: number;
  complexity: ComplexityScore;
}

/**
 * Language detection from file extensions and content
 */
export const languageDetection: Record<string, LanguageDetectionResult> = {
  typescript: {
    language: 'TypeScript',
    confidence: 0.95,
    extensions: ['.ts', '.tsx'],
    mimeTypes: ['text/typescript', 'application/typescript'],
  },
  javascript: {
    language: 'JavaScript',
    confidence: 0.95,
    extensions: ['.js', '.jsx', '.mjs'],
    mimeTypes: ['text/javascript', 'application/javascript'],
  },
  python: {
    language: 'Python',
    confidence: 0.95,
    extensions: ['.py', '.pyi'],
    mimeTypes: ['text/x-python', 'application/x-python'],
  },
  java: {
    language: 'Java',
    confidence: 0.95,
    extensions: ['.java'],
    mimeTypes: ['text/x-java-source'],
  },
  golang: {
    language: 'Go',
    confidence: 0.95,
    extensions: ['.go'],
    mimeTypes: ['text/x-go'],
  },
  rust: {
    language: 'Rust',
    confidence: 0.95,
    extensions: ['.rs'],
    mimeTypes: ['text/x-rust'],
  },
  csharp: {
    language: 'C#',
    confidence: 0.95,
    extensions: ['.cs'],
    mimeTypes: ['text/x-csharp'],
  },
  cpp: {
    language: 'C++',
    confidence: 0.95,
    extensions: ['.cpp', '.cc', '.cxx', '.h', '.hpp'],
    mimeTypes: ['text/x-c++src'],
  },
  kotlin: {
    language: 'Kotlin',
    confidence: 0.95,
    extensions: ['.kt', '.kts'],
    mimeTypes: ['text/x-kotlin'],
  },
  swift: {
    language: 'Swift',
    confidence: 0.95,
    extensions: ['.swift'],
    mimeTypes: ['text/x-swift'],
  },
};

/**
 * Detect programming language from file extension
 */
export function detectLanguageByExtension(filePath: string): LanguageDetectionResult | null {
  const extension = filePath.toLowerCase().substring(filePath.lastIndexOf('.'));

  for (const [, detection] of Object.entries(languageDetection)) {
    if (detection.extensions.includes(extension)) {
      return detection;
    }
  }

  return null;
}

/**
 * Detect programming language from content
 */
export function detectLanguageByContent(content: string): LanguageDetectionResult | null {
  // Check for shebang
  if (content.startsWith('#!/usr/bin/env python')) {
    return languageDetection.python;
  }
  if (content.startsWith('#!/usr/bin/env node')) {
    return languageDetection.javascript;
  }

  // Check for language-specific imports/syntax
  if (
    content.includes('import java.') ||
    content.includes('package ') ||
    content.match(/public class \w+/)
  ) {
    return languageDetection.java;
  }

  if (
    content.includes('from typing') ||
    content.match(/^import \w+ as \w+/) ||
    content.match(/def \w+\(/)
  ) {
    return languageDetection.python;
  }

  if (
    content.includes('package main') ||
    content.match(/func \w+\(/)
  ) {
    return languageDetection.golang;
  }

  if (content.match(/^import React/) || content.match(/^import { } from ['"]react/)) {
    return languageDetection.typescript || languageDetection.javascript;
  }

  return null;
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

/**
 * Calculate code metrics
 */
export function calculateCodeMetrics(content: string, language: string): CodeMetrics {
  const lines = content.split('\n');

  const blankLines = lines.filter((line) => line.trim().length === 0).length;

  let commentLines = 0;
  let inBlockComment = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('/*') || trimmed.startsWith('//') || trimmed.startsWith('#')) {
      commentLines++;
    }
    if (trimmed.includes('/*')) inBlockComment = true;
    if (trimmed.includes('*/')) inBlockComment = false;
    if (inBlockComment && !trimmed.includes('/*')) commentLines++;
  }

  const codeLines = lines.length - blankLines - commentLines;
  const totalLines = lines.length;
  const commentRatio = totalLines > 0 ? commentLines / totalLines : 0;

  const complexity = calculateComplexity(content, language);

  return {
    totalLines,
    blankLines,
    commentLines,
    codeLines,
    commentRatio,
    complexity,
  };
}

/**
 * Analyze code quality
 */
export function analyzeCodeQuality(content: string, language: string): {
  metricsRating: 'excellent' | 'good' | 'fair' | 'poor';
  feedback: string[];
  recommendations: string[];
} {
  const metrics = calculateCodeMetrics(content, language);
  const feedback: string[] = [];
  const recommendations: string[] = [];

  // Comment ratio
  if (metrics.commentRatio < 0.05) {
    recommendations.push('Increase code documentation - current ratio is below 5%');
  } else if (metrics.commentRatio > 0.3) {
    feedback.push('High comment ratio - consider refactoring for clarity');
  }

  // Complexity
  if (metrics.complexity.cyclomaticComplexity > 15) {
    recommendations.push('Break down complex functions - cyclomatic complexity is high');
  }

  if (metrics.complexity.cognitiveComplexity > 25) {
    recommendations.push('Simplify cognitive complexity - consider extracting logic');
  }

  // Code to comment ratio
  if (metrics.commentLines === 0 && metrics.codeLines > 100) {
    recommendations.push('Add comments to explain complex logic');
  }

  // Determine rating
  let rating: 'excellent' | 'good' | 'fair' | 'poor' = 'good';

  if (
    metrics.complexity.cyclomaticComplexity > 20 ||
    metrics.complexity.cognitiveComplexity > 30
  ) {
    rating = 'poor';
  } else if (
    metrics.complexity.cyclomaticComplexity > 15 ||
    metrics.commentRatio < 0.03
  ) {
    rating = 'fair';
  } else if (metrics.commentRatio > 0.15 && metrics.complexity.cyclomaticComplexity < 10) {
    rating = 'excellent';
  }

  return {
    metricsRating: rating,
    feedback,
    recommendations,
  };
}
