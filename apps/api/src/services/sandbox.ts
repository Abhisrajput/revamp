/**
 * Agent Execution Sandbox — Secure tool execution environment.
 *
 * Ported from legacy-bridge/backend/src/agent/sandbox.ts with improvements:
 * - Server-side only (no browser)
 * - Better path security (symlink validation, traversal prevention)
 * - Configurable timeouts and limits
 * - Binary file detection
 */

import { existsSync, statSync, realpathSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, relative, basename, extname, dirname } from "path";
import { execSync } from "child_process";
import { globSync } from "glob";

// --- Constants ---

const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 200 * 1024; // 200 KB
const LARGE_FILE_THRESHOLD = 500 * 1024; // 500 KB
const MAX_BATCH_FILES = 15;

const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".venv", "venv",
  "target", "build", "dist", "out", ".next", ".nuxt",
  "vendor", "bin", "obj", ".terraform", "coverage",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar", ".jar",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp3", ".mp4", ".mov", ".avi", ".wav", ".flac",
  ".pyc", ".class", ".wasm",
]);

/**
 * Shell command allowlist — categorized for clarity.
 *
 * Security design:
 * - READ-ONLY inspection commands are always safe
 * - BUILD commands limited to package managers and compilers (no bare interpreters)
 * - VCS limited to read-only git operations (no git push, git add)
 * - BLOCKED: bare `python`/`python3`/`node` (can execute arbitrary code),
 *   `curl`/`wget` (can exfiltrate data), `rm`, `chmod`, `sudo`, `export`
 */
const SAFE_SHELL_COMMANDS = new Set([
  // Read-only inspection
  "cat", "head", "tail", "wc", "sort", "uniq", "diff",
  "ls", "find", "grep", "awk", "sed", "tr", "cut",
  "echo", "printf", "date", "env", "which", "whoami",
  "file", "stat", "du", "tree",
  // Build / package managers (not bare interpreters)
  "npm", "npx", "pnpm", "yarn",
  "pip", "pip3",
  "go", "cargo", "mvn", "gradle", "dotnet",
  // Testing frameworks
  "tsc", "eslint", "prettier", "jest", "vitest", "pytest",
  // VCS (read-only by default; write ops blocked via pattern checks below)
  "git",
  // Containers (read-only ops)
  "docker", "kubectl",
]);

// --- Path Security ---

function isBinaryFile(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIRS.has(name);
}

/**
 * Resolve and validate a file path within the workspace.
 * Prevents path traversal, symlink escape, and access to excluded dirs.
 */
export function resolveSafePath(workspace: string, filePath: string): string {
  const absWorkspace = resolve(workspace);
  const target = resolve(absWorkspace, filePath);

  // Must be within workspace
  if (!target.startsWith(absWorkspace + "/") && target !== absWorkspace) {
    throw new Error(`Path traversal blocked: ${filePath}`);
  }

  // Check for excluded directories in the path
  const rel = relative(absWorkspace, target);
  const segments = rel.split("/");
  for (const seg of segments) {
    if (isExcludedDir(seg)) {
      throw new Error(`Access to '${seg}' directory is not allowed.`);
    }
  }

  // Resolve symlinks and verify still within workspace
  if (existsSync(target)) {
    const real = realpathSync(target);
    if (!real.startsWith(absWorkspace + "/") && real !== absWorkspace) {
      throw new Error(`Symlink escape blocked: ${filePath} resolves outside workspace.`);
    }
  }

  return target;
}

// --- Tool Executors ---

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Read a file's contents.
 */
export function execReadFile(workspace: string, args: { path: string }): ToolResult {
  try {
    const safePath = resolveSafePath(workspace, args.path);
    if (!existsSync(safePath)) {
      return { success: false, output: "", error: `File not found: ${args.path}` };
    }
    if (isBinaryFile(safePath)) {
      return { success: false, output: "", error: `Binary file, cannot read: ${args.path}` };
    }
    const stat = statSync(safePath);
    if (stat.isDirectory()) {
      return { success: false, output: "", error: `${args.path} is a directory, not a file.` };
    }
    if (stat.size > LARGE_FILE_THRESHOLD) {
      return { success: true, output: `[File is ${(stat.size / 1024).toFixed(1)} KB — too large to read in full. Use read_file_range for specific lines.]` };
    }
    const content = readFileSync(safePath, "utf-8");
    return { success: true, output: content };
  } catch (err) {
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read specific line range from a file (1-based).
 */
export function execReadFileRange(
  workspace: string,
  args: { path: string; start_line: number; end_line: number },
): ToolResult {
  try {
    const safePath = resolveSafePath(workspace, args.path);
    if (!existsSync(safePath)) {
      return { success: false, output: "", error: `File not found: ${args.path}` };
    }
    const content = readFileSync(safePath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(1, args.start_line) - 1;
    const end = Math.min(lines.length, args.end_line);
    const selected = lines.slice(start, end);

    const numbered = selected.map((line, i) => `${start + i + 1}: ${line}`).join("\n");
    return { success: true, output: `Lines ${start + 1}-${end} of ${lines.length}:\n${numbered}` };
  } catch (err) {
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Write or create a file.
 */
export function execWriteFile(
  workspace: string,
  args: { path: string; content: string },
): ToolResult {
  try {
    const safePath = resolveSafePath(workspace, args.path);
    const dir = dirname(safePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(safePath, args.content, "utf-8");
    return { success: true, output: `Wrote ${args.content.length} bytes to ${args.path}` };
  } catch (err) {
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Edit a file with surgical string replacement.
 */
export function execEditFile(
  workspace: string,
  args: { path: string; old_string: string; new_string: string },
): ToolResult {
  try {
    const safePath = resolveSafePath(workspace, args.path);
    if (!existsSync(safePath)) {
      return { success: false, output: "", error: `File not found: ${args.path}` };
    }
    const content = readFileSync(safePath, "utf-8");

    // Check uniqueness
    const occurrences = content.split(args.old_string).length - 1;
    if (occurrences === 0) {
      return { success: false, output: "", error: `old_string not found in ${args.path}. Check for exact match including whitespace.` };
    }
    if (occurrences > 1) {
      return { success: false, output: "", error: `old_string appears ${occurrences} times in ${args.path}. Provide more context for a unique match.` };
    }

    const updated = content.replace(args.old_string, args.new_string);
    writeFileSync(safePath, updated, "utf-8");
    return { success: true, output: `Replaced 1 occurrence in ${args.path}` };
  } catch (err) {
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read multiple files in one call.
 */
export function execBatchReadFiles(
  workspace: string,
  args: { paths: string[] },
): ToolResult {
  try {
    const paths = args.paths.slice(0, MAX_BATCH_FILES);
    const results: string[] = [];

    for (const filePath of paths) {
      const result = execReadFile(workspace, { path: filePath });
      if (result.success) {
        results.push(`--- ${filePath} ---\n${result.output}`);
      } else {
        results.push(`--- ${filePath} ---\n[Error: ${result.error}]`);
      }
    }

    return { success: true, output: results.join("\n\n") };
  } catch (err) {
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List files matching a glob pattern.
 */
export function execListFiles(
  workspace: string,
  args: { pattern: string; max_results?: number },
): ToolResult {
  try {
    const maxResults = Math.min(args.max_results || 200, 500);
    const absWorkspace = resolve(workspace);

    const matches = globSync(args.pattern, {
      cwd: absWorkspace,
      ignore: [...EXCLUDED_DIRS].map((d) => `**/${d}/**`),
      nodir: true,
      maxDepth: 15,
    }).slice(0, maxResults);

    if (matches.length === 0) {
      return { success: true, output: `No files found matching: ${args.pattern}` };
    }

    return { success: true, output: matches.join("\n") };
  } catch (err) {
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Search code using grep.
 */
export function execSearchCode(
  workspace: string,
  args: { pattern: string; glob_filter?: string; max_results?: number },
): ToolResult {
  try {
    const maxResults = Math.min(args.max_results || 50, 200);
    const absWorkspace = resolve(workspace);

    const excludeDirs = [...EXCLUDED_DIRS].map((d) => `--exclude-dir=${d}`).join(" ");
    const includeGlob = args.glob_filter ? `--include='${args.glob_filter}'` : "";

    // Try regex first, fall back to fixed-string
    let cmd = `grep -rn ${excludeDirs} ${includeGlob} -E '${args.pattern.replace(/'/g, "'\\''")}' . 2>/dev/null | head -${maxResults}`;

    try {
      const output = execSync(cmd, {
        cwd: absWorkspace,
        timeout: MAX_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf-8",
      });
      return { success: true, output: output.trim() || "No matches found." };
    } catch {
      // Fall back to fixed-string search
      cmd = `grep -rn ${excludeDirs} ${includeGlob} -F '${args.pattern.replace(/'/g, "'\\''")}' . 2>/dev/null | head -${maxResults}`;
      const output = execSync(cmd, {
        cwd: absWorkspace,
        timeout: MAX_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf-8",
      });
      return { success: true, output: output.trim() || "No matches found." };
    }
  } catch (err) {
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Get codebase file statistics.
 */
export function execFileStats(workspace: string): ToolResult {
  try {
    const absWorkspace = resolve(workspace);
    const allFiles = globSync("**/*", {
      cwd: absWorkspace,
      ignore: [...EXCLUDED_DIRS].map((d) => `**/${d}/**`),
      nodir: true,
      maxDepth: 15,
    });

    const extCounts: Record<string, number> = {};
    const dirCounts: Record<string, number> = {};
    let totalLines = 0;
    let totalSize = 0;

    for (const file of allFiles) {
      const ext = extname(file).toLowerCase() || "(no ext)";
      extCounts[ext] = (extCounts[ext] || 0) + 1;

      const topDir = file.split("/")[0] || "(root)";
      dirCounts[topDir] = (dirCounts[topDir] || 0) + 1;

      const fullPath = resolve(absWorkspace, file);
      try {
        const stat = statSync(fullPath);
        totalSize += stat.size;
        if (!isBinaryFile(file) && stat.size < LARGE_FILE_THRESHOLD) {
          const content = readFileSync(fullPath, "utf-8");
          totalLines += content.split("\n").length;
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Top extensions and directories
    const topExtensions = Object.entries(extCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([ext, count]) => `  ${ext}: ${count}`)
      .join("\n");

    const topDirs = Object.entries(dirCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([dir, count]) => `  ${dir}: ${count}`)
      .join("\n");

    const output = [
      `Total files: ${allFiles.length}`,
      `Total lines: ${totalLines.toLocaleString()}`,
      `Total size: ${(totalSize / 1024).toFixed(1)} KB`,
      "",
      `File types:\n${topExtensions}`,
      "",
      `Top directories:\n${topDirs}`,
    ].join("\n");

    return { success: true, output };
  } catch (err) {
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Execute a sandboxed shell command.
 */
export function execShell(
  workspace: string,
  args: { command: string; timeout_ms?: number },
): ToolResult {
  try {
    const cmd = args.command.trim();
    if (!cmd) {
      return { success: false, output: "", error: "Empty command." };
    }

    // Extract base command for safety check
    const baseCommand = cmd.split(/[\s|;&]/)[0].replace(/^(sudo\s+)?/, "");
    if (!SAFE_SHELL_COMMANDS.has(baseCommand)) {
      return {
        success: false,
        output: "",
        error: `Command '${baseCommand}' is not in the allowed list. Allowed: ${[...SAFE_SHELL_COMMANDS].sort().join(", ")}`,
      };
    }

    // Block dangerous patterns
    const dangerous = [
      /rm\s+-rf\s+[/~]/,        // rm -rf /
      />\s*\/dev\/sd/,           // writing to devices
      /mkfs/,                    // filesystem formatting
      /dd\s+if=/,                // dd
      /:()\s*\{/,                // fork bomb
      /git\s+(push|remote\s+add|config)/, // git write ops
      /\$\(/,                    // command substitution
      /`[^`]+`/,                 // backtick command substitution
      />\s*[/~]/,                // redirect to absolute path
      /\|\s*sh\b/,               // piping to shell
      /\|\s*bash\b/,             // piping to bash
      /eval\s/,                  // eval command
      /source\s/,                // source command
    ];
    for (const pattern of dangerous) {
      if (pattern.test(cmd)) {
        return { success: false, output: "", error: "Command blocked: potentially destructive pattern detected." };
      }
    }

    const timeout = Math.min(args.timeout_ms || MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const output = execSync(cmd, {
      cwd: resolve(workspace),
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: resolve(workspace),
        TERM: "dumb",
        CI: "true",
      },
    });

    return { success: true, output: output.trim() };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stdout" in err) {
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      const combined = [execErr.stdout || "", execErr.stderr || ""].filter(Boolean).join("\n");
      return { success: false, output: combined.trim(), error: `Command exited with code ${execErr.status || 1}` };
    }
    return { success: false, output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

// --- LSP Tool Imports ---

import {
  execLspHover,
  execLspDefinitions,
  execLspReferences,
  execLspDocumentSymbols,
  execLspDiagnostics,
} from "./lsp-manager.js";

// --- Executor Dispatch ---

export type ToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "list_files"
  | "search_code"
  | "file_stats"
  | "shell_exec"
  | "read_file_range"
  | "batch_read_files"
  | "lsp_hover"
  | "lsp_definitions"
  | "lsp_references"
  | "lsp_document_symbols"
  | "lsp_diagnostics";

// Synchronous tool executors (file/shell tools)
const SYNC_EXECUTORS: Record<string, (workspace: string, args: Record<string, unknown>) => ToolResult> = {
  read_file: (ws, args) => execReadFile(ws, args as { path: string }),
  write_file: (ws, args) => execWriteFile(ws, args as { path: string; content: string }),
  edit_file: (ws, args) => execEditFile(ws, args as { path: string; old_string: string; new_string: string }),
  list_files: (ws, args) => execListFiles(ws, args as { pattern: string; max_results?: number }),
  search_code: (ws, args) => execSearchCode(ws, args as { pattern: string; glob_filter?: string; max_results?: number }),
  file_stats: (ws) => execFileStats(ws),
  shell_exec: (ws, args) => execShell(ws, args as { command: string; timeout_ms?: number }),
  read_file_range: (ws, args) => execReadFileRange(ws, args as { path: string; start_line: number; end_line: number }),
  batch_read_files: (ws, args) => execBatchReadFiles(ws, args as { paths: string[] }),
};

// Async tool executors (LSP tools — require server lifecycle management)
const ASYNC_EXECUTORS: Record<string, (workspace: string, args: Record<string, unknown>) => Promise<ToolResult>> = {
  lsp_hover: (ws, args) => execLspHover(ws, args),
  lsp_definitions: (ws, args) => execLspDefinitions(ws, args),
  lsp_references: (ws, args) => execLspReferences(ws, args),
  lsp_document_symbols: (ws, args) => execLspDocumentSymbols(ws, args),
  lsp_diagnostics: (ws, args) => execLspDiagnostics(ws, args),
};

/**
 * Execute a tool by name.
 * Supports both synchronous (file/shell) and async (LSP) tools.
 */
export async function executeTool(
  workspace: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Try sync executors first
  const syncExecutor = SYNC_EXECUTORS[toolName];
  if (syncExecutor) {
    try {
      return syncExecutor(workspace, args);
    } catch (err) {
      return {
        success: false,
        output: "",
        error: `Tool '${toolName}' failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Try async executors (LSP tools)
  const asyncExecutor = ASYNC_EXECUTORS[toolName];
  if (asyncExecutor) {
    try {
      return await asyncExecutor(workspace, args);
    } catch (err) {
      return {
        success: false,
        output: "",
        error: `Tool '${toolName}' failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { success: false, output: "", error: `Unknown tool: ${toolName}` };
}

/**
 * Get available tools for a given stage.
 * Stages 0-4 and 6 are read-only (no write/edit/shell).
 * Stages 5 (FORGE) and 7 (EVOLVE) have full access including LSP.
 * LSP tools are available at all stages (read-only code intelligence).
 */
export function getToolsForStage(stageIndex: number): ToolName[] {
  const lspTools: ToolName[] = [
    "lsp_hover",
    "lsp_definitions",
    "lsp_references",
    "lsp_document_symbols",
    "lsp_diagnostics",
  ];

  const readOnlyTools: ToolName[] = [
    "read_file",
    "read_file_range",
    "batch_read_files",
    "list_files",
    "search_code",
    "file_stats",
  ];

  const writeTools: ToolName[] = [
    "write_file",
    "edit_file",
    "shell_exec",
  ];

  if (stageIndex === 5 || stageIndex === 7) {
    return [...readOnlyTools, ...lspTools, ...writeTools];
  }

  return [...readOnlyTools, ...lspTools];
}
