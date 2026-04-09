/**
 * Security Inspector Chain — Goose-inspired multi-layer input validation.
 *
 * Inspectors run in priority order before tool execution, shell commands,
 * and file system operations. Each inspector returns an allow/deny decision
 * with a risk level for observability.
 *
 * Inspector chain:
 *   1. Shell command inspector — blocks dangerous commands
 *   2. Path inspector — prevents directory traversal
 *   3. Environment inspector — blocks sensitive variable access
 *   4. Input length inspector — prevents resource exhaustion
 */

import { resolve, sep } from "path";

// ─── TYPES ──────────────────────────────────────────────────────

export interface InspectionResult {
  allowed: boolean;
  reason?: string;
  inspector: string;
  riskLevel: "none" | "low" | "medium" | "high" | "critical";
}

function allow(inspector: string): InspectionResult {
  return { allowed: true, inspector, riskLevel: "none" };
}

function deny(inspector: string, reason: string, riskLevel: InspectionResult["riskLevel"] = "high"): InspectionResult {
  return { allowed: false, reason, inspector, riskLevel };
}

// ─── SHELL COMMAND INSPECTOR ────────────────────────────────────

/** Patterns that indicate dangerous shell commands */
const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive)\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bchmod\s+(-[a-z]*R\s+)?[0-7]{3,4}\s+\//i,
  /\bchown\s+(-[a-z]*R\s+)?.*\//i,
  />\s*\/dev\/(sda|hd[a-z]|nvme)/i,
  /\bcurl\b.*\|\s*(ba)?sh/i,
  /\bwget\b.*\|\s*(ba)?sh/i,
  /\beval\s*\(/i,
  /;\s*(rm|curl|wget|nc|ncat)\b/i,
  /`[^`]*`/,  // backtick command substitution
  /\$\([^)]*\)/,  // $() command substitution in unexpected places
];

/** Commands that are always allowed */
const SAFE_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "grep", "find", "echo",
  "pwd", "whoami", "date", "wc", "sort", "uniq", "diff",
  "git", "node", "npm", "pnpm", "npx", "tsc", "go",
  "mkdir", "cp", "mv", "touch",
]);

/**
 * Inspect a shell command for dangerous patterns.
 */
export function inspectShellCommand(command: string): InspectionResult {
  const trimmed = command.trim();

  // Extract the base command (first word)
  const baseCommand = trimmed.split(/[\s;|&]/)[0].replace(/^.*\//, "");

  if (SAFE_COMMANDS.has(baseCommand)) {
    // Still check for injection patterns even in safe commands
    const hasPipeToShell = /\|\s*(ba)?sh\b/.test(trimmed);
    if (hasPipeToShell) {
      return deny("shell", `Pipe to shell detected in command: ${baseCommand}`, "critical");
    }
    return allow("shell");
  }

  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return deny("shell", `Dangerous command pattern: ${pattern.source}`, "critical");
    }
  }

  // Check for command chaining with semicolons (possible injection)
  const chainedCommands = trimmed.split(/[;&|]{1,2}/).filter(Boolean);
  if (chainedCommands.length > 3) {
    return deny("shell", "Excessive command chaining detected", "medium");
  }

  return allow("shell");
}

// ─── PATH INSPECTOR ─────────────────────────────────────────────

/**
 * Inspect a file path to ensure it stays within the allowed workspace.
 */
export function inspectFilePath(filePath: string, workspace: string): InspectionResult {
  const resolvedWorkspace = resolve(workspace);
  const resolvedPath = resolve(workspace, filePath);

  if (resolvedPath !== resolvedWorkspace && !resolvedPath.startsWith(resolvedWorkspace + sep)) {
    return deny("path", `Path traversal: ${filePath} resolves outside workspace`, "critical");
  }

  // Check for null bytes (bypass technique)
  if (filePath.includes("\0")) {
    return deny("path", "Null byte in path", "critical");
  }

  // Check for encoded traversal attempts
  if (/%2e/i.test(filePath) || /%2f/i.test(filePath) || /%5c/i.test(filePath)) {
    return deny("path", "URL-encoded path traversal characters detected", "high");
  }

  return allow("path");
}

// ─── ENVIRONMENT INSPECTOR ──────────────────────────────────────

/** Environment variables that should never be exposed or modified */
const BLOCKED_ENV_VARS = new Set([
  // System paths
  "PATH", "LD_LIBRARY_PATH", "LD_PRELOAD", "DYLD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "NODE_PATH", "RUBYLIB",
  // Auth & secrets
  "DATABASE_URL", "REDIS_URL", "JWT_SECRET", "SESSION_SECRET",
  "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_AI_API_KEY",
  "S3_SECRET_KEY", "S3_ACCESS_KEY",
  // System identity
  "HOME", "USER", "SHELL", "TERM", "SSH_AUTH_SOCK",
  "SUDO_USER", "SUDO_COMMAND",
]);

/**
 * Inspect an environment variable name for security.
 */
export function inspectEnvVar(name: string): InspectionResult {
  if (BLOCKED_ENV_VARS.has(name.toUpperCase())) {
    return deny("env", `Blocked environment variable: ${name}`, "high");
  }

  if (name.toUpperCase().includes("SECRET") || name.toUpperCase().includes("PASSWORD") || name.toUpperCase().includes("TOKEN")) {
    return deny("env", `Sensitive environment variable pattern: ${name}`, "medium");
  }

  return allow("env");
}

// ─── INPUT LENGTH INSPECTOR ─────────────────────────────────────

const MAX_COMMAND_LENGTH = 10_000;
const MAX_PATH_LENGTH = 4096;
const MAX_INPUT_LENGTH = 1_000_000;

/**
 * Inspect input length to prevent resource exhaustion.
 */
export function inspectInputLength(
  input: string,
  type: "command" | "path" | "body",
): InspectionResult {
  const limit = type === "command" ? MAX_COMMAND_LENGTH
    : type === "path" ? MAX_PATH_LENGTH
    : MAX_INPUT_LENGTH;

  if (input.length > limit) {
    return deny("length", `${type} exceeds max length (${input.length} > ${limit})`, "medium");
  }

  return allow("length");
}

// ─── BRANCH NAME INSPECTOR ──────────────────────────────────────

const SAFE_BRANCH_PATTERN = /^[a-zA-Z0-9._\/-]+$/;

/**
 * Inspect a git branch name for shell injection characters.
 */
export function inspectBranchName(branch: string): InspectionResult {
  if (!SAFE_BRANCH_PATTERN.test(branch)) {
    return deny("branch", `Invalid characters in branch name: ${branch}`, "critical");
  }

  if (branch.length > 255) {
    return deny("branch", "Branch name too long", "low");
  }

  return allow("branch");
}

// ─── CHAIN RUNNER ───────────────────────────────────────────────

/**
 * Run multiple inspectors and return the first denial, or allow if all pass.
 * Inspectors run in priority order — first denial stops the chain.
 */
export function runInspectorChain(...results: InspectionResult[]): InspectionResult {
  for (const result of results) {
    if (!result.allowed) return result;
  }
  return results[results.length - 1] || allow("chain");
}
