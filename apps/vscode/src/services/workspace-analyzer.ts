import * as vscode from "vscode";
import * as path from "path";

export interface FilePattern {
  pattern: string;
  severity: "info" | "warning" | "critical";
  description: string;
}

export interface AnalysisResult {
  file: string;
  language: string;
  issues: Array<{
    pattern: string;
    severity: string;
    line: number;
    description: string;
  }>;
  metrics: {
    lines_of_code: number;
    complexity: number;
    legacy_score: number; // 0-100, higher = more legacy
  };
}

const LEGACY_PATTERNS: FilePattern[] = [
  {
    pattern: "var\\s+\\w+",
    severity: "warning",
    description: "Use let/const instead of var",
  },
  {
    pattern: "function\\s+\\w+\\s*\\(",
    severity: "info",
    description: "Consider using arrow functions",
  },
  {
    pattern: "callback\\(|success\\s*:|error\\s*:",
    severity: "warning",
    description: "Use promises or async/await instead of callbacks",
  },
  {
    pattern: "require\\(",
    severity: "info",
    description: "Consider using ES6 imports",
  },
  {
    pattern: "eval\\(",
    severity: "critical",
    description: "Never use eval()",
  },
  {
    pattern: "document\\.write",
    severity: "warning",
    description: "Avoid document.write, use DOM APIs instead",
  },
];

export class WorkspaceAnalyzer {
  async analyzeFile(uri: vscode.Uri): Promise<AnalysisResult> {
    const document = await vscode.workspace.openTextDocument(uri);
    const content = document.getText();
    const language = document.languageId;
    const filename = path.basename(uri.fsPath);

    // Analyze for legacy patterns
    const issues: AnalysisResult["issues"] = [];
    const lines = content.split("\n");

    for (const pattern of LEGACY_PATTERNS) {
      const regex = new RegExp(pattern.pattern, "gm");
      let match;

      while ((match = regex.exec(content)) !== null) {
        const lineNumber = content.substring(0, match.index).split("\n").length;
        issues.push({
          pattern: pattern.pattern,
          severity: pattern.severity,
          line: lineNumber,
          description: pattern.description,
        });
      }
    }

    // Calculate metrics
    const metrics = {
      lines_of_code: lines.length,
      complexity: this.calculateComplexity(content),
      legacy_score: this.calculateLegacyScore(issues, lines.length),
    };

    return {
      file: filename,
      language,
      issues,
      metrics,
    };
  }

  async analyzeWorkspace(): Promise<AnalysisResult[]> {
    const files = await vscode.workspace.findFiles("**/*.{js,ts,jsx,tsx,py,java,cs,go}");
    const results: AnalysisResult[] = [];

    for (const file of files.slice(0, 50)) {
      // Limit to first 50 files
      try {
        const result = await this.analyzeFile(file);
        results.push(result);
      } catch (error) {
        console.error(`Failed to analyze ${file.fsPath}:`, error);
      }
    }

    return results;
  }

  private calculateComplexity(content: string): number {
    let complexity = 1;
    const patterns = [
      /\bif\b/g,
      /\belse\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bswitch\b/g,
      /\bcatch\b/g,
      /\b\?\s*:/g, // ternary operator
    ];

    for (const pattern of patterns) {
      const matches = content.match(pattern);
      if (matches) {
        complexity += matches.length;
      }
    }

    return Math.min(complexity, 100); // Cap at 100
  }

  private calculateLegacyScore(issues: AnalysisResult["issues"], fileSize: number): number {
    const severityWeights = { info: 1, warning: 3, critical: 10 };
    const issueScore = issues.reduce((sum, issue) => {
      const weight = severityWeights[issue.severity as keyof typeof severityWeights] || 1;
      return sum + weight;
    }, 0);

    // Normalize to 0-100 scale
    const normalizedScore = Math.min((issueScore / fileSize) * 100, 100);
    return Math.round(normalizedScore);
  }
}

export const workspaceAnalyzer = new WorkspaceAnalyzer();
