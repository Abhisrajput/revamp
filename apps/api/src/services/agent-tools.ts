/**
 * Agent Tool Definitions — JSON Schema specifications for all sandbox tools.
 *
 * Ported from legacy-bridge/backend/src/agent/tools.ts with additions:
 * - Type-safe tool schemas
 * - Stage-based permission filtering
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

// --- Tool Schemas ---

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read the contents of a file. Returns the full file content as text. Binary files are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file within the workspace." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file. Creates the file and any intermediate directories if they don't exist. Overwrites existing files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path for the file." },
        content: { type: "string", description: "The full content to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Make a surgical edit to a file by replacing a unique string. The old_string must appear exactly once in the file. Include enough surrounding context for uniqueness.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file." },
        old_string: { type: "string", description: "The exact text to find and replace (must be unique)." },
        new_string: { type: "string", description: "The replacement text." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_files",
    description: "List files matching a glob pattern. Returns file paths relative to the workspace root. Excludes node_modules, .git, build directories, etc.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g. '**/*.ts', 'src/**/*.java')." },
        max_results: { type: "number", description: "Maximum files to return (default: 200, max: 500)." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "search_code",
    description: "Search for a pattern across files using grep. Supports regex patterns. Returns matching lines with file paths and line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search pattern (regex or plain text)." },
        glob_filter: { type: "string", description: "Optional glob to limit search scope (e.g. '*.ts')." },
        max_results: { type: "number", description: "Maximum matches to return (default: 50, max: 200)." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "file_stats",
    description: "Get an overview of the codebase: file counts by extension, total lines of code, directory sizes, and overall structure.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "read_file_range",
    description: "Read specific lines from a file. Useful for large files. Line numbers are 1-based.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file." },
        start_line: { type: "number", description: "Start line (1-based, inclusive)." },
        end_line: { type: "number", description: "End line (1-based, inclusive)." },
      },
      required: ["path", "start_line", "end_line"],
    },
  },
  {
    name: "batch_read_files",
    description: "Read multiple files in a single call. Maximum 15 files per batch. Returns concatenated contents with file path headers.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Array of relative file paths to read (max 15).",
        },
      },
      required: ["paths"],
    },
  },
  {
    name: "shell_exec",
    description: "Execute a shell command in the workspace. Limited to safe commands (npm, pip, git, node, python, testing frameworks, etc.). Destructive commands are blocked.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute." },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default: 30000, max: 30000)." },
      },
      required: ["command"],
    },
  },
];

// --- LSP Tool Schemas ---

export const LSP_TOOLS: ToolDefinition[] = [
  {
    name: "lsp_hover",
    description: "Get type information, documentation, and hover details for a symbol at a specific position in a file. Uses the Language Server Protocol for accurate, language-aware results. Supports 63 languages including TypeScript, Python, Go, Rust, Java, C/C++, COBOL, and more.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file within the workspace." },
        line: { type: "number", description: "Line number (1-based)." },
        character: { type: "number", description: "Column/character position (1-based)." },
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "lsp_definitions",
    description: "Find the definition location of a symbol at a specific position. Returns the file path and line number where the symbol is defined. Works across files and modules.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file within the workspace." },
        line: { type: "number", description: "Line number (1-based)." },
        character: { type: "number", description: "Column/character position (1-based)." },
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "lsp_references",
    description: "Find all references to a symbol at a specific position across the codebase. Returns file paths and line numbers of every usage, including the definition itself.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file within the workspace." },
        line: { type: "number", description: "Line number (1-based)." },
        character: { type: "number", description: "Column/character position (1-based)." },
      },
      required: ["path", "line", "character"],
    },
  },
  {
    name: "lsp_document_symbols",
    description: "Get a hierarchical outline of all symbols (functions, classes, variables, methods, interfaces, etc.) in a file. Useful for understanding file structure at a glance.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file within the workspace." },
      },
      required: ["path"],
    },
  },
  {
    name: "lsp_diagnostics",
    description: "Get compiler errors, type errors, warnings, and other diagnostics for a file. Returns severity, location, and message for each issue found by the language server.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file within the workspace." },
      },
      required: ["path"],
    },
  },
];

// Combined list of all tools (file + LSP)
const ALL_TOOLS = [...AGENT_TOOLS, ...LSP_TOOLS];

/**
 * Get tool definitions filtered by stage permissions.
 * LSP tools are available at all stages (read-only code intelligence).
 * Write tools (write_file, edit_file, shell_exec) only at FORGE and EVOLVE.
 */
export function getToolsForStage(stageIndex: number): ToolDefinition[] {
  const writeNames = new Set([
    "write_file", "edit_file", "shell_exec",
  ]);

  if (stageIndex === 5 || stageIndex === 7) {
    // FORGE and EVOLVE: full access (all file + LSP tools)
    return ALL_TOOLS;
  }

  // Other stages: read-only file tools + all LSP tools
  return ALL_TOOLS.filter((t) => !writeNames.has(t.name));
}

/**
 * Get all tool definitions.
 */
export function getAllTools(): ToolDefinition[] {
  return ALL_TOOLS;
}
