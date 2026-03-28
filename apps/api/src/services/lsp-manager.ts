/**
 * LSP Server lifecycle management and tool executors.
 *
 * Manages per-workspace language servers, handles initialization,
 * document synchronization, and exposes tool executor functions
 * that integrate into the existing agent sandbox.
 *
 * Ported from legacy-bridge/backend/src/agent/lspManager.ts
 * - 63 language server configurations with primary + fallback commands
 * - Per-workspace server caching with 5-minute idle TTL
 * - Automatic workspace dependency resolution (Node, Python, Go, Rust, Java, etc.)
 * - 5 LSP tool executors: hover, definitions, references, documentSymbols, diagnostics
 */

import { spawn, execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  JsonRpcConnection,
  symbolKindName,
  severityName,
  type LspPosition,
  type LspLocation,
  type LspDiagnostic,
  type LspHoverResult,
  type LspDocumentSymbol,
  type LspSymbolInformation,
} from "./lsp-client.js";
import { resolveSafePath, type ToolResult } from "./sandbox.js";

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

interface LanguageServerConfig {
  /** Primary command to spawn */
  command: string;
  args: string[];
  /** Fallback command if primary isn't found */
  fallback?: { command: string; args: string[] };
  /** Second fallback */
  fallback2?: { command: string; args: string[] };
  /** LSP language identifier */
  languageId: string;
  /** File extensions this server handles */
  extensions: Set<string>;
}

const LANGUAGE_SERVERS: Record<string, LanguageServerConfig> = {
  // ── 1. TypeScript / JavaScript ──────────────────────────────────────
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    fallback: {
      command: "npx",
      args: ["-y", "typescript-language-server", "--stdio"],
    },
    languageId: "typescript",
    extensions: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
  },
  // ── 2. HTML / CSS / JSON (vscode-langservers-extracted) ─────────────
  html: {
    command: "vscode-html-language-server",
    args: ["--stdio"],
    fallback: {
      command: "npx",
      args: ["-y", "vscode-langservers-extracted", "--stdio"],
    },
    languageId: "html",
    extensions: new Set([".html", ".htm"]),
  },
  css: {
    command: "vscode-css-language-server",
    args: ["--stdio"],
    languageId: "css",
    extensions: new Set([".css", ".scss", ".less"]),
  },
  json: {
    command: "vscode-json-language-server",
    args: ["--stdio"],
    languageId: "json",
    extensions: new Set([".json", ".jsonc"]),
  },
  eslint: {
    command: "vscode-eslint-language-server",
    args: ["--stdio"],
    languageId: "javascript",
    extensions: new Set([".eslintrc", ".eslintrc.js", ".eslintrc.json"]),
  },
  // ── 3. Tailwind CSS ─────────────────────────────────────────────────
  tailwindcss: {
    command: "tailwindcss-language-server",
    args: ["--stdio"],
    languageId: "tailwindcss",
    extensions: new Set([".tailwind"]),
  },
  // ── 4. Angular ──────────────────────────────────────────────────────
  angular: {
    command: "ngserver",
    args: ["--stdio"],
    fallback: {
      command: "npx",
      args: ["-y", "@angular/language-server", "--stdio"],
    },
    languageId: "typescript",
    extensions: new Set([".component.ts", ".component.html"]),
  },
  // ── 5. Svelte ───────────────────────────────────────────────────────
  svelte: {
    command: "svelteserver",
    args: ["--stdio"],
    fallback: {
      command: "npx",
      args: ["-y", "svelte-language-server", "--stdio"],
    },
    languageId: "svelte",
    extensions: new Set([".svelte"]),
  },
  // ── 6. Vue (Volar) ─────────────────────────────────────────────────
  vue: {
    command: "vue-language-server",
    args: ["--stdio"],
    fallback: {
      command: "npx",
      args: ["-y", "@vue/language-server", "--stdio"],
    },
    languageId: "vue",
    extensions: new Set([".vue"]),
  },
  // ── 7. Astro ────────────────────────────────────────────────────────
  astro: {
    command: "astro-ls",
    args: ["--stdio"],
    languageId: "astro",
    extensions: new Set([".astro"]),
  },
  // ── 8. Python (pyright, pylsp, jedi) ────────────────────────────────
  python: {
    command: "pyright-langserver",
    args: ["--stdio"],
    fallback: { command: "pylsp", args: [] },
    fallback2: { command: "jedi-language-server", args: [] },
    languageId: "python",
    extensions: new Set([".py", ".pyi"]),
  },
  // ── 9. Rust ─────────────────────────────────────────────────────────
  rust: {
    command: "rust-analyzer",
    args: [],
    languageId: "rust",
    extensions: new Set([".rs"]),
  },
  // ── 10. Go ──────────────────────────────────────────────────────────
  go: {
    command: "gopls",
    args: ["serve"],
    languageId: "go",
    extensions: new Set([".go"]),
  },
  // ── 11. Java (Eclipse JDT LS) ───────────────────────────────────────
  java: {
    command: "jdtls",
    args: [],
    languageId: "java",
    extensions: new Set([".java"]),
  },
  // ── 12. Kotlin ──────────────────────────────────────────────────────
  kotlin: {
    command: "kotlin-language-server",
    args: [],
    languageId: "kotlin",
    extensions: new Set([".kt", ".kts"]),
  },
  // ── 13. C# (OmniSharp) ─────────────────────────────────────────────
  csharp: {
    command: "OmniSharp",
    args: ["--languageserver"],
    languageId: "csharp",
    extensions: new Set([".cs", ".csx"]),
  },
  // ── 14. Ruby (ruby-lsp, solargraph, sorbet) ─────────────────────────
  ruby: {
    command: "ruby-lsp",
    args: [],
    fallback: { command: "solargraph", args: ["stdio"] },
    fallback2: { command: "srb", args: ["typecheck", "--lsp"] },
    languageId: "ruby",
    extensions: new Set([".rb", ".rake", ".gemspec"]),
  },
  // ── 15. PHP (phpactor, intelephense) ────────────────────────────────
  php: {
    command: "phpactor",
    args: ["language-server"],
    fallback: { command: "intelephense", args: ["--stdio"] },
    languageId: "php",
    extensions: new Set([".php", ".phtml"]),
  },
  // ── 16. Scala (Metals) ──────────────────────────────────────────────
  scala: {
    command: "metals",
    args: [],
    languageId: "scala",
    extensions: new Set([".scala", ".sc", ".sbt"]),
  },
  // ── 17. Erlang ──────────────────────────────────────────────────────
  erlang: {
    command: "erlang_ls",
    args: [],
    languageId: "erlang",
    extensions: new Set([".erl", ".hrl"]),
  },
  // ── 18. Elixir ──────────────────────────────────────────────────────
  elixir: {
    command: "elixir-ls",
    args: [],
    fallback: { command: "language_server.sh", args: [] },
    languageId: "elixir",
    extensions: new Set([".ex", ".exs"]),
  },
  // ── 19. Haskell ─────────────────────────────────────────────────────
  haskell: {
    command: "haskell-language-server-wrapper",
    args: ["--lsp"],
    languageId: "haskell",
    extensions: new Set([".hs", ".lhs"]),
  },
  // ── 20. OCaml ───────────────────────────────────────────────────────
  ocaml: {
    command: "ocamllsp",
    args: [],
    languageId: "ocaml",
    extensions: new Set([".ml", ".mli"]),
  },
  // ── 21. C / C++ (clangd) ────────────────────────────────────────────
  cpp: {
    command: "clangd",
    args: [],
    languageId: "cpp",
    extensions: new Set([
      ".c",
      ".h",
      ".cpp",
      ".cc",
      ".cxx",
      ".hpp",
      ".hxx",
      ".hh",
    ]),
  },
  // ── 22. Zig ─────────────────────────────────────────────────────────
  zig: {
    command: "zls",
    args: [],
    languageId: "zig",
    extensions: new Set([".zig"]),
  },
  // ── 23. Assembly ────────────────────────────────────────────────────
  assembly: {
    command: "asm-lsp",
    args: [],
    languageId: "asm",
    extensions: new Set([".asm", ".s", ".S"]),
  },
  // ── 24. Ada ─────────────────────────────────────────────────────────
  ada: {
    command: "ada_language_server",
    args: [],
    languageId: "ada",
    extensions: new Set([".adb", ".ads"]),
  },
  // ── 25. COBOL ───────────────────────────────────────────────────────
  cobol: {
    command: "cobol-language-support",
    args: [],
    fallback: { command: "che-che4z-lsp-for-cobol", args: [] },
    languageId: "cobol",
    extensions: new Set([".cob", ".cbl", ".cpy", ".cobol"]),
  },
  // ── 26. RPG / RPGLE ─────────────────────────────────────────────────
  rpg: {
    command: "rpglsp",
    args: [],
    languageId: "rpgle",
    extensions: new Set([".rpgle", ".rpg", ".sqlrpgle"]),
  },
  // ── 27. PL/I, JCL, REXX (Zowe / zopeneditor) ───────────────────────
  pli: {
    command: "zopeneditor",
    args: ["--stdio"],
    languageId: "pli",
    extensions: new Set([".pli", ".pl1", ".jcl", ".rexx", ".rex"]),
  },
  // ── 28. HLASM ───────────────────────────────────────────────────────
  hlasm: {
    command: "hlasm_language_server",
    args: [],
    languageId: "hlasm",
    extensions: new Set([".hlasm"]),
  },
  // ── 29. SQL (generic, PostgreSQL, multi-dialect) ─────────────────────
  sql: {
    command: "sql-language-server",
    args: ["up", "--method", "stdio"],
    fallback: { command: "pgls", args: [] },
    fallback2: { command: "sqls", args: [] },
    languageId: "sql",
    extensions: new Set([".sql"]),
  },
  // ── 30. dbt (dbt-osmosis) ───────────────────────────────────────────
  dbt: {
    command: "dbt-osmosis",
    args: ["server"],
    languageId: "sql",
    extensions: new Set([".dbt"]),
  },
  // ── 31. SPARQL ──────────────────────────────────────────────────────
  sparql: {
    command: "sparql-language-server",
    args: ["--stdio"],
    languageId: "sparql",
    extensions: new Set([".sparql", ".rq"]),
  },
  // ── 32. YAML ────────────────────────────────────────────────────────
  yaml: {
    command: "yaml-language-server",
    args: ["--stdio"],
    languageId: "yaml",
    extensions: new Set([".yaml", ".yml"]),
  },
  // ── 33. Terraform ───────────────────────────────────────────────────
  terraform: {
    command: "terraform-ls",
    args: ["serve"],
    languageId: "terraform",
    extensions: new Set([".tf", ".tfvars"]),
  },
  // ── 34. Dockerfile ──────────────────────────────────────────────────
  dockerfile: {
    command: "docker-langserver",
    args: ["--stdio"],
    fallback: {
      command: "npx",
      args: ["-y", "dockerfile-language-server-nodejs", "--stdio"],
    },
    languageId: "dockerfile",
    extensions: new Set([".dockerfile"]),
  },
  // ── 35. Ansible ─────────────────────────────────────────────────────
  ansible: {
    command: "ansible-language-server",
    args: ["--stdio"],
    languageId: "ansible",
    extensions: new Set([".ansible.yml", ".ansible.yaml"]),
  },
  // ── 36. Helm ────────────────────────────────────────────────────────
  helm: {
    command: "helm_ls",
    args: ["serve"],
    languageId: "helm",
    extensions: new Set([".helmignore"]),
  },
  // ── 37. Bicep (Azure) ───────────────────────────────────────────────
  bicep: {
    command: "bicep-langserver",
    args: ["--stdio"],
    languageId: "bicep",
    extensions: new Set([".bicep"]),
  },
  // ── 38. CloudFormation ──────────────────────────────────────────────
  cloudformation: {
    command: "cfn-lsp-extra",
    args: [],
    languageId: "yaml",
    extensions: new Set([".cfn.yml", ".cfn.yaml", ".cfn.json"]),
  },
  // ── 39. Bash / Shell ────────────────────────────────────────────────
  bash: {
    command: "bash-language-server",
    args: ["start"],
    languageId: "shellscript",
    extensions: new Set([".sh", ".bash", ".zsh", ".ksh"]),
  },
  // ── 40. PowerShell ──────────────────────────────────────────────────
  powershell: {
    command: "pwsh",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "Start-EditorServices",
      "-Stdio",
    ],
    languageId: "powershell",
    extensions: new Set([".ps1", ".psm1", ".psd1"]),
  },
  // ── 41. Lua ─────────────────────────────────────────────────────────
  lua: {
    command: "lua-language-server",
    args: [],
    languageId: "lua",
    extensions: new Set([".lua"]),
  },
  // ── 42. Perl ────────────────────────────────────────────────────────
  perl: {
    command: "perl-language-server",
    args: [],
    languageId: "perl",
    extensions: new Set([".pl", ".pm", ".t"]),
  },
  // ── 43. VimScript ───────────────────────────────────────────────────
  vim: {
    command: "vim-language-server",
    args: [],
    languageId: "vim",
    extensions: new Set([".vim", ".vimrc"]),
  },
  // ── 44. R ───────────────────────────────────────────────────────────
  r: {
    command: "R",
    args: ["--slave", "-e", "languageserver::run()"],
    languageId: "r",
    extensions: new Set([".r", ".R", ".Rmd"]),
  },
  // ── 45. Julia ───────────────────────────────────────────────────────
  julia: {
    command: "julia",
    args: [
      "--startup-file=no",
      "-e",
      "using LanguageServer; runserver()",
    ],
    languageId: "julia",
    extensions: new Set([".jl"]),
  },
  // ── 46. Stan ────────────────────────────────────────────────────────
  stan: {
    command: "stan-language-server",
    args: [],
    languageId: "stan",
    extensions: new Set([".stan"]),
  },
  // ── 47. Swift / Objective-C (SourceKit-LSP) ─────────────────────────
  swift: {
    command: "sourcekit-lsp",
    args: [],
    languageId: "swift",
    extensions: new Set([".swift", ".m", ".mm"]),
  },
  // ── 48. Dart / Flutter ──────────────────────────────────────────────
  dart: {
    command: "dart",
    args: ["language-server", "--protocol=lsp"],
    languageId: "dart",
    extensions: new Set([".dart"]),
  },
  // ── 49. LaTeX (texlab) ──────────────────────────────────────────────
  latex: {
    command: "texlab",
    args: [],
    languageId: "latex",
    extensions: new Set([".tex", ".bib", ".sty", ".cls"]),
  },
  // ── 50. Markdown / LaTeX grammar (ltex-ls) ──────────────────────────
  ltex: {
    command: "ltex-ls",
    args: [],
    languageId: "markdown",
    extensions: new Set([".md", ".markdown", ".rst"]),
  },
  // ── 51. TOML (taplo) ────────────────────────────────────────────────
  toml: {
    command: "taplo",
    args: ["lsp", "stdio"],
    languageId: "toml",
    extensions: new Set([".toml"]),
  },
  // ── 52. Markdown (marksman) ─────────────────────────────────────────
  marksman: {
    command: "marksman",
    args: ["server"],
    languageId: "markdown",
    extensions: new Set([".mdx"]),
  },
  // ── 53. Protobuf ────────────────────────────────────────────────────
  protobuf: {
    command: "proto-language-server",
    args: [],
    fallback: { command: "buf", args: ["lsp"] },
    languageId: "proto",
    extensions: new Set([".proto"]),
  },
  // ── 54. GraphQL ─────────────────────────────────────────────────────
  graphql: {
    command: "graphql-lsp",
    args: ["server", "-m", "stream"],
    languageId: "graphql",
    extensions: new Set([".graphql", ".gql"]),
  },
  // ── 55. Thrift ──────────────────────────────────────────────────────
  thrift: {
    command: "thrift-language-server",
    args: [],
    languageId: "thrift",
    extensions: new Set([".thrift"]),
  },
};

// Map from extension to language key
const EXTENSION_TO_LANGUAGE = new Map<string, string>();
for (const [lang, config] of Object.entries(LANGUAGE_SERVERS)) {
  for (const ext of config.extensions) {
    // First registration wins — don't override (e.g. .asm → assembly, not hlasm)
    if (!EXTENSION_TO_LANGUAGE.has(ext)) {
      EXTENSION_TO_LANGUAGE.set(ext, lang);
    }
  }
}

// Languages recognized for detection but without an LSP server.
const RECOGNIZED_NO_SERVER: Record<string, string[]> = {
  vb6: [".vbp", ".frm", ".bas", ".vbg", ".vbw"],
  foxpro: [".prg", ".scx", ".vcx", ".pjx", ".dbf"],
  delphi: [".pas", ".dpr", ".dpk", ".dfm"],
  access: [".mdb", ".accdb", ".mde", ".accde"],
  vba: [".vba"],
  fortran: [".f", ".f90", ".f95", ".f03", ".for"],
};
for (const [lang, exts] of Object.entries(RECOGNIZED_NO_SERVER)) {
  for (const ext of exts) {
    if (!EXTENSION_TO_LANGUAGE.has(ext)) {
      EXTENSION_TO_LANGUAGE.set(ext, lang);
    }
  }
}

// Special-case filename-based detection
const FILENAME_TO_LANGUAGE: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "bash",
  Rakefile: "ruby",
  Gemfile: "ruby",
  Vagrantfile: "ruby",
  Jenkinsfile: "bash",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
};

// Per-extension LSP language identifiers (sent in textDocument/didOpen)
const EXTENSION_LANGUAGE_ID: Record<string, string> = {
  // TypeScript / JavaScript
  ".ts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".jsx": "javascriptreact",
  ".mjs": "javascript", ".cjs": "javascript",
  // Web
  ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".less": "less",
  ".json": "json", ".jsonc": "jsonc",
  ".vue": "vue", ".svelte": "svelte", ".astro": "astro",
  // Python
  ".py": "python", ".pyi": "python",
  // Systems
  ".go": "go", ".rs": "rust",
  ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
  ".hpp": "cpp", ".hxx": "cpp", ".hh": "cpp",
  ".zig": "zig",
  ".asm": "asm", ".s": "asm", ".S": "asm",
  // JVM
  ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
  ".scala": "scala", ".sc": "scala", ".sbt": "sbt",
  // .NET
  ".cs": "csharp", ".csx": "csharp",
  // Scripting
  ".rb": "ruby", ".rake": "ruby", ".gemspec": "ruby",
  ".php": "php", ".phtml": "php",
  ".pl": "perl", ".pm": "perl", ".t": "perl",
  ".lua": "lua", ".vim": "vim",
  ".r": "r", ".R": "r", ".Rmd": "r",
  ".jl": "julia",
  // Shell
  ".sh": "shellscript", ".bash": "shellscript", ".zsh": "shellscript", ".ksh": "shellscript",
  ".ps1": "powershell", ".psm1": "powershell", ".psd1": "powershell",
  // Functional
  ".hs": "haskell", ".lhs": "haskell",
  ".ml": "ocaml", ".mli": "ocaml",
  ".erl": "erlang", ".hrl": "erlang",
  ".ex": "elixir", ".exs": "elixir",
  // Legacy
  ".vbp": "vb6", ".frm": "vb6", ".bas": "vb6",
  ".pas": "pascal", ".dpr": "pascal", ".dfm": "delphi",
  // Mainframe
  ".cob": "cobol", ".cbl": "cobol", ".cpy": "cobol", ".cobol": "cobol",
  ".rpgle": "rpgle", ".rpg": "rpgle", ".sqlrpgle": "rpgle",
  ".pli": "pli", ".pl1": "pli",
  ".jcl": "jcl", ".rexx": "rexx", ".rex": "rexx",
  ".hlasm": "hlasm",
  ".adb": "ada", ".ads": "ada",
  // Data / Query
  ".sql": "sql",
  ".sparql": "sparql", ".rq": "sparql",
  ".graphql": "graphql", ".gql": "graphql",
  ".proto": "proto", ".thrift": "thrift",
  // Config / IaC
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml",
  ".tf": "terraform", ".tfvars": "terraform",
  ".bicep": "bicep",
  ".dockerfile": "dockerfile",
  // Mobile
  ".swift": "swift", ".m": "objective-c", ".mm": "objective-cpp",
  ".dart": "dart",
  // Documents / Markup
  ".tex": "latex", ".bib": "bibtex", ".sty": "latex", ".cls": "latex",
  ".md": "markdown", ".markdown": "markdown", ".rst": "restructuredtext",
  ".mdx": "mdx",
  // Misc
  ".stan": "stan",
};

export function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (EXTENSION_TO_LANGUAGE.has(ext)) return EXTENSION_TO_LANGUAGE.get(ext)!;
  const basename = path.basename(filePath);
  return FILENAME_TO_LANGUAGE[basename] || null;
}

function getLanguageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_LANGUAGE_ID[ext] || "plaintext";
}

function fileUri(absPath: string): string {
  return `file://${absPath.startsWith("/") ? "" : "/"}${absPath}`;
}

function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) return decodeURIComponent(uri.slice(7));
  return uri;
}

// ---------------------------------------------------------------------------
// Command availability check
// ---------------------------------------------------------------------------

function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// LSP Server wrapper
// ---------------------------------------------------------------------------

class LSPServer {
  private conn: JsonRpcConnection;
  private openDocuments = new Set<string>();
  private diagnosticsCache = new Map<string, LspDiagnostic[]>();
  private initialized = false;
  private _serverCapabilities: Record<string, unknown> = {};

  constructor(
    private language: string,
    private workspace: string,
    conn: JsonRpcConnection,
  ) {
    this.conn = conn;
    // Listen for publishDiagnostics notifications
    this.conn.onNotification(
      "textDocument/publishDiagnostics",
      (params: unknown) => {
        const p = params as {
          uri?: string;
          diagnostics?: LspDiagnostic[];
        };
        if (p?.uri && Array.isArray(p.diagnostics)) {
          this.diagnosticsCache.set(uriToPath(p.uri), p.diagnostics);
        }
      },
    );
  }

  get isAlive(): boolean {
    return this.conn.isAlive && this.initialized;
  }

  async initialize(): Promise<void> {
    const rootUri = fileUri(this.workspace);
    const result = (await this.conn.request("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: this.workspace,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: false },
          references: {},
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          publishDiagnostics: { relatedInformation: true },
          synchronization: {
            didOpen: true,
            didClose: true,
            didChange: true,
          },
        },
        workspace: {
          workspaceFolders: true,
        },
      },
      workspaceFolders: [
        { uri: rootUri, name: path.basename(this.workspace) },
      ],
    })) as { capabilities?: Record<string, unknown> };

    this._serverCapabilities = result?.capabilities || {};
    this.conn.notify("initialized", {});
    this.initialized = true;
  }

  async openDocument(absPath: string): Promise<void> {
    const uri = fileUri(absPath);
    if (this.openDocuments.has(uri)) return;

    let text: string;
    try {
      text = await readFile(absPath, "utf-8");
    } catch {
      throw new Error(`Cannot read file: ${absPath}`);
    }

    this.conn.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: getLanguageId(absPath),
        version: 1,
        text,
      },
    });
    this.openDocuments.add(uri);

    // Give the server a moment to process the document
    await new Promise((r) => setTimeout(r, 200));
  }

  async closeDocument(absPath: string): Promise<void> {
    const uri = fileUri(absPath);
    if (!this.openDocuments.has(uri)) return;
    this.conn.notify("textDocument/didClose", { textDocument: { uri } });
    this.openDocuments.delete(uri);
  }

  async hover(
    absPath: string,
    position: LspPosition,
  ): Promise<LspHoverResult | null> {
    await this.openDocument(absPath);
    const result = await this.conn.request("textDocument/hover", {
      textDocument: { uri: fileUri(absPath) },
      position,
    });
    return (result as LspHoverResult) || null;
  }

  async definition(
    absPath: string,
    position: LspPosition,
  ): Promise<LspLocation[]> {
    await this.openDocument(absPath);
    const result = await this.conn.request("textDocument/definition", {
      textDocument: { uri: fileUri(absPath) },
      position,
    });
    if (!result) return [];
    if (Array.isArray(result)) {
      return result.map(
        (
          item: LspLocation & {
            targetUri?: string;
            targetRange?: unknown;
          },
        ) => {
          if (item.targetUri) {
            return {
              uri: item.targetUri,
              range: (item.targetRange ||
                item.range) as LspLocation["range"],
            };
          }
          return item as LspLocation;
        },
      );
    }
    return [result as LspLocation];
  }

  async references(
    absPath: string,
    position: LspPosition,
  ): Promise<LspLocation[]> {
    await this.openDocument(absPath);
    const result = await this.conn.request("textDocument/references", {
      textDocument: { uri: fileUri(absPath) },
      position,
      context: { includeDeclaration: true },
    });
    if (!result) return [];
    return Array.isArray(result)
      ? (result as LspLocation[])
      : [result as LspLocation];
  }

  async documentSymbols(
    absPath: string,
  ): Promise<(LspDocumentSymbol | LspSymbolInformation)[]> {
    await this.openDocument(absPath);
    const result = await this.conn.request("textDocument/documentSymbol", {
      textDocument: { uri: fileUri(absPath) },
    });
    if (!result) return [];
    return Array.isArray(result) ? result : [];
  }

  async getDiagnostics(absPath: string): Promise<LspDiagnostic[]> {
    await this.openDocument(absPath);
    // Wait a bit longer for diagnostics to arrive via notification
    await new Promise((r) => setTimeout(r, 1500));
    return this.diagnosticsCache.get(absPath) || [];
  }

  shutdown(): void {
    for (const uri of this.openDocuments) {
      try {
        this.conn.notify("textDocument/didClose", {
          textDocument: { uri },
        });
      } catch {
        /* ignore */
      }
    }
    this.openDocuments.clear();
    this.diagnosticsCache.clear();
    this.conn
      .request("shutdown", null)
      .catch(() => {});
    setTimeout(() => {
      try {
        this.conn.notify("exit", null);
      } catch {
        /* ignore */
      }
      this.conn.close();
    }, 500);
  }
}

// ---------------------------------------------------------------------------
// Workspace dependency resolution for LSP servers
// ---------------------------------------------------------------------------

const resolvedWorkspaces = new Set<string>();

function detectNodePackageManager(
  workspace: string,
): { cmd: string; installArgs: string[] } {
  if (fs.existsSync(path.join(workspace, "pnpm-lock.yaml"))) {
    return {
      cmd: "pnpm",
      installArgs: ["install", "--frozen-lockfile", "--ignore-scripts"],
    };
  }
  if (fs.existsSync(path.join(workspace, "yarn.lock"))) {
    return {
      cmd: "yarn",
      installArgs: ["install", "--frozen-lockfile", "--ignore-scripts"],
    };
  }
  return {
    cmd: "npm",
    installArgs: ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
  };
}

async function ensureWorkspaceDeps(
  workspace: string,
  language: string,
): Promise<void> {
  const wsKey = `${workspace}::${language}`;
  if (resolvedWorkspaces.has(wsKey)) return;

  try {
    await ensureWorkspaceDepsInner(workspace, language);
  } catch (err) {
    console.warn(
      `[lsp] Dependency resolution failed for ${language} (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }

  resolvedWorkspaces.add(wsKey);
}

async function ensureWorkspaceDepsInner(
  workspace: string,
  language: string,
): Promise<void> {
  // ── Node.js ecosystem ─────────────────────────────────────────────
  const NODE_LANGUAGES = new Set([
    "typescript", "vue", "svelte", "angular", "astro",
    "html", "css", "json", "eslint", "tailwindcss",
  ]);

  const REQUIRED_NODE_PACKAGES: Record<string, string[]> = {
    typescript: ["typescript"],
    vue: ["typescript", "vue"],
    svelte: ["typescript", "svelte"],
    angular: ["typescript", "@angular/language-service"],
    astro: ["typescript", "astro"],
    eslint: ["eslint"],
    tailwindcss: ["tailwindcss"],
  };

  if (NODE_LANGUAGES.has(language)) {
    const hasPkgJson = fs.existsSync(path.join(workspace, "package.json"));
    const hasNodeModules = fs.existsSync(path.join(workspace, "node_modules"));
    const requiredPkgs = REQUIRED_NODE_PACKAGES[language] || [];
    const missingPkgs = requiredPkgs.filter(
      (pkg) => !fs.existsSync(path.join(workspace, "node_modules", pkg)),
    );

    if (!hasNodeModules && hasPkgJson) {
      const pm = detectNodePackageManager(workspace);
      console.log(
        `[lsp] Running ${pm.cmd} install for ${language} in ${workspace}...`,
      );
      await execFileAsync(pm.cmd, pm.installArgs, {
        cwd: workspace,
        timeout: 180_000,
      });
    } else if (missingPkgs.length > 0) {
      console.log(
        `[lsp] Installing missing packages for ${language}: ${missingPkgs.join(", ")}`,
      );
      await execFileAsync(
        "npm",
        [
          "install",
          "--no-save",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          ...missingPkgs,
        ],
        { cwd: workspace, timeout: 60_000 },
      );
    }
    return;
  }

  // ── Python ────────────────────────────────────────────────────────
  if (language === "python") {
    const hasVenv =
      fs.existsSync(path.join(workspace, ".venv")) ||
      fs.existsSync(path.join(workspace, "venv"));
    if (hasVenv) return;

    const hasReqs = fs.existsSync(
      path.join(workspace, "requirements.txt"),
    );
    const hasPyproject = fs.existsSync(
      path.join(workspace, "pyproject.toml"),
    );
    const hasSetupPy = fs.existsSync(path.join(workspace, "setup.py"));

    if (hasReqs || hasPyproject || hasSetupPy) {
      console.log(`[lsp] Creating Python venv in ${workspace}...`);
      await execFileAsync("python3", ["-m", "venv", ".venv"], {
        cwd: workspace,
        timeout: 30_000,
      });
      const pip = path.join(workspace, ".venv", "bin", "pip");

      if (hasReqs) {
        await execFileAsync(
          pip,
          [
            "install",
            "-q",
            "--no-warn-script-location",
            "-r",
            "requirements.txt",
          ],
          { cwd: workspace, timeout: 180_000 },
        );
      } else if (hasPyproject || hasSetupPy) {
        await execFileAsync(
          pip,
          ["install", "-q", "--no-warn-script-location", "-e", "."],
          { cwd: workspace, timeout: 180_000 },
        );
      }
    }
    return;
  }

  // ── Go ────────────────────────────────────────────────────────────
  if (language === "go") {
    const hasGoMod = fs.existsSync(path.join(workspace, "go.mod"));
    const hasGoSum = fs.existsSync(path.join(workspace, "go.sum"));
    if (hasGoMod && hasGoSum) {
      console.log(`[lsp] Running go mod download in ${workspace}...`);
      await execFileAsync("go", ["mod", "download"], {
        cwd: workspace,
        timeout: 120_000,
      });
    }
    return;
  }

  // ── Rust ──────────────────────────────────────────────────────────
  if (language === "rust") {
    const hasCargoToml = fs.existsSync(
      path.join(workspace, "Cargo.toml"),
    );
    if (hasCargoToml) {
      console.log(`[lsp] Running cargo fetch in ${workspace}...`);
      await execFileAsync("cargo", ["fetch"], {
        cwd: workspace,
        timeout: 180_000,
      });
    }
    return;
  }

  // ── Java / Kotlin ─────────────────────────────────────────────────
  if (language === "java" || language === "kotlin") {
    const hasPomXml = fs.existsSync(path.join(workspace, "pom.xml"));
    const hasGradlew = fs.existsSync(path.join(workspace, "gradlew"));
    const hasBuildGradle =
      fs.existsSync(path.join(workspace, "build.gradle")) ||
      fs.existsSync(path.join(workspace, "build.gradle.kts"));

    if (hasPomXml && commandExists("mvn")) {
      await execFileAsync("mvn", ["dependency:resolve", "-q", "-B"], {
        cwd: workspace,
        timeout: 300_000,
      });
    } else if (hasGradlew) {
      await execFileAsync(
        path.join(workspace, "gradlew"),
        ["dependencies", "--console=plain", "-q"],
        { cwd: workspace, timeout: 300_000 },
      );
    } else if (hasBuildGradle && commandExists("gradle")) {
      await execFileAsync(
        "gradle",
        ["dependencies", "--console=plain", "-q"],
        { cwd: workspace, timeout: 300_000 },
      );
    }
    return;
  }

  // ── C# ────────────────────────────────────────────────────────────
  if (language === "csharp") {
    const hasCsproj = (() => {
      try {
        return fs
          .readdirSync(workspace)
          .some((f) => f.endsWith(".csproj") || f.endsWith(".sln"));
      } catch {
        return false;
      }
    })();
    if (hasCsproj && commandExists("dotnet")) {
      await execFileAsync("dotnet", ["restore", "--verbosity", "quiet"], {
        cwd: workspace,
        timeout: 180_000,
      });
    }
    return;
  }

  // ── Ruby ──────────────────────────────────────────────────────────
  if (language === "ruby") {
    const hasGemfile = fs.existsSync(path.join(workspace, "Gemfile"));
    const hasVendor = fs.existsSync(
      path.join(workspace, "vendor", "bundle"),
    );
    if (hasGemfile && !hasVendor && commandExists("bundle")) {
      await execFileAsync(
        "bundle",
        [
          "install",
          "--path",
          "vendor/bundle",
          "--jobs",
          "4",
          "--retry",
          "2",
        ],
        { cwd: workspace, timeout: 180_000 },
      );
    }
    return;
  }

  // ── PHP ───────────────────────────────────────────────────────────
  if (language === "php") {
    const hasComposer = fs.existsSync(
      path.join(workspace, "composer.json"),
    );
    const hasVendor = fs.existsSync(path.join(workspace, "vendor"));
    if (hasComposer && !hasVendor && commandExists("composer")) {
      await execFileAsync(
        "composer",
        ["install", "--no-scripts", "--no-interaction", "--quiet"],
        { cwd: workspace, timeout: 180_000 },
      );
    }
    return;
  }

  // ── Scala ─────────────────────────────────────────────────────────
  if (language === "scala") {
    const hasBuildSbt = fs.existsSync(
      path.join(workspace, "build.sbt"),
    );
    if (hasBuildSbt && commandExists("sbt")) {
      await execFileAsync("sbt", ["bloopInstall", "-batch"], {
        cwd: workspace,
        timeout: 300_000,
      });
    }
    return;
  }

  // ── Elixir ────────────────────────────────────────────────────────
  if (language === "elixir") {
    const hasMixExs = fs.existsSync(path.join(workspace, "mix.exs"));
    const hasDeps = fs.existsSync(path.join(workspace, "deps"));
    if (hasMixExs && !hasDeps && commandExists("mix")) {
      await execFileAsync("mix", ["deps.get"], {
        cwd: workspace,
        timeout: 120_000,
      });
    }
    return;
  }

  // ── Dart / Flutter ────────────────────────────────────────────────
  if (language === "dart") {
    const hasPubspec = fs.existsSync(
      path.join(workspace, "pubspec.yaml"),
    );
    const hasPubCache =
      fs.existsSync(path.join(workspace, ".dart_tool")) ||
      fs.existsSync(path.join(workspace, ".packages"));
    if (hasPubspec && !hasPubCache) {
      const isFlutter = (() => {
        try {
          const content = fs.readFileSync(
            path.join(workspace, "pubspec.yaml"),
            "utf-8",
          );
          return content.includes("flutter:");
        } catch {
          return false;
        }
      })();
      if (isFlutter && commandExists("flutter")) {
        await execFileAsync("flutter", ["pub", "get"], {
          cwd: workspace,
          timeout: 120_000,
        });
      } else if (commandExists("dart")) {
        await execFileAsync("dart", ["pub", "get"], {
          cwd: workspace,
          timeout: 120_000,
        });
      }
    }
    return;
  }

  // ── Haskell ───────────────────────────────────────────────────────
  if (language === "haskell") {
    const hasCabal = fs
      .readdirSync(workspace)
      .some((f) => f.endsWith(".cabal"));
    const hasStack = fs.existsSync(path.join(workspace, "stack.yaml"));
    if (hasStack && commandExists("stack")) {
      await execFileAsync("stack", ["setup", "--no-terminal"], {
        cwd: workspace,
        timeout: 300_000,
      });
    } else if (hasCabal && commandExists("cabal")) {
      await execFileAsync("cabal", ["update"], {
        cwd: workspace,
        timeout: 120_000,
      });
      await execFileAsync("cabal", ["build", "--only-dependencies"], {
        cwd: workspace,
        timeout: 300_000,
      });
    }
    return;
  }

  // ── Terraform ─────────────────────────────────────────────────────
  if (language === "terraform") {
    const hasTfFiles = fs
      .readdirSync(workspace)
      .some((f) => f.endsWith(".tf"));
    const hasTerraformDir = fs.existsSync(
      path.join(workspace, ".terraform"),
    );
    if (hasTfFiles && !hasTerraformDir && commandExists("terraform")) {
      await execFileAsync(
        "terraform",
        ["init", "-backend=false", "-input=false"],
        { cwd: workspace, timeout: 120_000 },
      );
    }
    return;
  }

  // ── C / C++ ───────────────────────────────────────────────────────
  if (language === "cpp") {
    const hasCmake = fs.existsSync(
      path.join(workspace, "CMakeLists.txt"),
    );
    const hasCompileCommands =
      fs.existsSync(path.join(workspace, "compile_commands.json")) ||
      fs.existsSync(
        path.join(workspace, "build", "compile_commands.json"),
      );
    if (hasCmake && !hasCompileCommands && commandExists("cmake")) {
      const buildDir = path.join(workspace, "build");
      fs.mkdirSync(buildDir, { recursive: true });
      await execFileAsync(
        "cmake",
        [
          "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON",
          "-B",
          "build",
          "-S",
          ".",
        ],
        { cwd: workspace, timeout: 60_000 },
      );
      const ccJson = path.join(buildDir, "compile_commands.json");
      const rootCcJson = path.join(workspace, "compile_commands.json");
      if (fs.existsSync(ccJson) && !fs.existsSync(rootCcJson)) {
        fs.symlinkSync(ccJson, rootCcJson);
      }
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// LSP Manager — caches servers per workspace+language
// ---------------------------------------------------------------------------

const serverCache = new Map<string, LSPServer>();
const SERVER_TTL_MS = 5 * 60 * 1000; // 5 minutes idle TTL
const serverTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cacheKey(workspace: string, language: string): string {
  return `${workspace}::${language}`;
}

function touchServer(key: string): void {
  const existing = serverTimers.get(key);
  if (existing) clearTimeout(existing);
  serverTimers.set(
    key,
    setTimeout(() => {
      const server = serverCache.get(key);
      if (server) {
        server.shutdown();
        serverCache.delete(key);
        serverTimers.delete(key);
      }
    }, SERVER_TTL_MS),
  );
}

async function getOrCreateServer(
  workspace: string,
  language: string,
): Promise<LSPServer> {
  const key = cacheKey(workspace, language);

  // Return cached server if alive
  const cached = serverCache.get(key);
  if (cached?.isAlive) {
    touchServer(key);
    return cached;
  }

  // Clean up dead server
  if (cached) {
    cached.shutdown();
    serverCache.delete(key);
  }

  const config = LANGUAGE_SERVERS[language];
  if (!config) {
    throw new Error(
      `No LSP server configured for language: ${language}`,
    );
  }

  // Auto-install workspace dependencies
  await ensureWorkspaceDeps(workspace, language);

  // Try primary command → fallback → fallback2
  let cmd = config.command;
  let args = config.args;

  if (!commandExists(cmd)) {
    let resolved = false;
    if (config.fallback) {
      if (
        config.fallback.command === "npx" ||
        commandExists(config.fallback.command)
      ) {
        cmd = config.fallback.command;
        args = config.fallback.args;
        resolved = true;
      }
    }
    if (!resolved && config.fallback2) {
      if (commandExists(config.fallback2.command)) {
        cmd = config.fallback2.command;
        args = config.fallback2.args;
        resolved = true;
      }
    }
    if (!resolved) {
      const alternatives = [
        config.fallback?.command,
        config.fallback2?.command,
      ].filter(Boolean);
      throw new Error(
        `LSP server for ${language} not found. Install "${config.command}"` +
          (alternatives.length > 0
            ? ` or ${alternatives.map((a) => `"${a}"`).join(" or ")}`
            : "") +
          ` to enable code intelligence for ${language} files.`,
      );
    }
  }

  // Spawn the language server
  const proc = spawn(cmd, args, {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
    },
  });

  // Wait for process to be ready (or fail)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(`LSP server "${cmd}" failed to start within 15s`),
      );
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 15_000);

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Failed to spawn LSP server "${cmd}": ${err.message}`,
        ),
      );
    });

    proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(
          new Error(
            `LSP server "${cmd}" exited with code ${code}`,
          ),
        );
      }
    });

    // Give a brief moment for the process to stabilize
    setTimeout(() => {
      clearTimeout(timeout);
      if (proc.exitCode !== null) {
        reject(
          new Error(
            `LSP server "${cmd}" exited immediately with code ${proc.exitCode}`,
          ),
        );
      } else {
        resolve();
      }
    }, 500);
  });

  const conn = new JsonRpcConnection(proc);
  const server = new LSPServer(language, workspace, conn);

  try {
    await server.initialize();
  } catch (err) {
    server.shutdown();
    throw new Error(
      `LSP initialization failed for ${language}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  serverCache.set(key, server);
  touchServer(key);
  return server;
}

/** Shut down all cached LSP servers. Call on process exit. */
export function shutdownAllServers(): void {
  for (const [key, server] of serverCache) {
    server.shutdown();
    const timer = serverTimers.get(key);
    if (timer) clearTimeout(timer);
  }
  serverCache.clear();
  serverTimers.clear();
}

/** Shut down all LSP servers for a specific workspace. */
export function shutdownWorkspaceServers(workspace: string): void {
  for (const [key, server] of serverCache) {
    if (key.startsWith(workspace + "::")) {
      server.shutdown();
      const timer = serverTimers.get(key);
      if (timer) clearTimeout(timer);
      serverCache.delete(key);
      serverTimers.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatLocation(loc: LspLocation, workspace: string): string {
  const absPath = uriToPath(loc.uri);
  const relPath = path.relative(workspace, absPath);
  const line = loc.range.start.line + 1;
  const char = loc.range.start.character + 1;
  return `${relPath}:${line}:${char}`;
}

function formatHoverContents(contents: LspHoverResult["contents"]): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((c) => (typeof c === "string" ? c : c.value))
      .join("\n\n");
  }
  if (typeof contents === "object" && "value" in contents) {
    return contents.value;
  }
  return JSON.stringify(contents);
}

function formatSymbol(
  sym: LspDocumentSymbol | LspSymbolInformation,
  indent = 0,
): string {
  const prefix = "  ".repeat(indent);
  const kindStr = symbolKindName("kind" in sym ? sym.kind : 0);

  if ("range" in sym && !("location" in sym)) {
    // DocumentSymbol format (hierarchical)
    const ds = sym as LspDocumentSymbol;
    const line = ds.range.start.line + 1;
    const detail = ds.detail ? ` — ${ds.detail}` : "";
    let result = `${prefix}${kindStr} ${ds.name}${detail} (line ${line})`;
    if (ds.children && ds.children.length > 0) {
      for (const child of ds.children) {
        result += "\n" + formatSymbol(child, indent + 1);
      }
    }
    return result;
  }

  // SymbolInformation format (flat)
  const si = sym as LspSymbolInformation;
  const line = si.location.range.start.line + 1;
  const container = si.containerName ? ` in ${si.containerName}` : "";
  return `${prefix}${kindStr} ${si.name}${container} (line ${line})`;
}

// ---------------------------------------------------------------------------
// Tool executors — called from sandbox.ts
// ---------------------------------------------------------------------------

export async function execLspHover(
  workspace: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const filePath = input.path as string;
  const line = input.line as number;
  const character = input.character as number;

  if (!filePath)
    return { success: false, output: "", error: "Missing required parameter: path" };
  if (typeof line !== "number" || line < 1)
    return { success: false, output: "", error: "line must be >= 1" };
  if (typeof character !== "number" || character < 1)
    return { success: false, output: "", error: "character must be >= 1" };

  const language = detectLanguage(filePath);
  if (!language)
    return {
      success: false,
      output: "",
      error: `No LSP support for file type: ${path.extname(filePath)}`,
    };

  const absPath = resolveSafePath(workspace, filePath);
  if (!fs.existsSync(absPath))
    return { success: false, output: "", error: `File not found: ${filePath}` };

  try {
    const server = await getOrCreateServer(workspace, language);
    const position: LspPosition = {
      line: line - 1,
      character: character - 1,
    };
    const result = await server.hover(absPath, position);

    if (!result || !result.contents) {
      return {
        success: true,
        output: `No hover information at ${filePath}:${line}:${character}`,
      };
    }

    const text = formatHoverContents(result.contents);
    return {
      success: true,
      output: `Hover at ${filePath}:${line}:${character}:\n\n${text}`,
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      error: `LSP hover failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function execLspDefinitions(
  workspace: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const filePath = input.path as string;
  const line = input.line as number;
  const character = input.character as number;

  if (!filePath)
    return { success: false, output: "", error: "Missing required parameter: path" };
  if (typeof line !== "number" || line < 1)
    return { success: false, output: "", error: "line must be >= 1" };
  if (typeof character !== "number" || character < 1)
    return { success: false, output: "", error: "character must be >= 1" };

  const language = detectLanguage(filePath);
  if (!language)
    return {
      success: false,
      output: "",
      error: `No LSP support for file type: ${path.extname(filePath)}`,
    };

  const absPath = resolveSafePath(workspace, filePath);
  if (!fs.existsSync(absPath))
    return { success: false, output: "", error: `File not found: ${filePath}` };

  try {
    const server = await getOrCreateServer(workspace, language);
    const position: LspPosition = {
      line: line - 1,
      character: character - 1,
    };
    const locations = await server.definition(absPath, position);

    if (locations.length === 0) {
      return {
        success: true,
        output: `No definition found at ${filePath}:${line}:${character}`,
      };
    }

    const formatted = locations
      .map((loc) => formatLocation(loc, workspace))
      .join("\n");
    return {
      success: true,
      output: `Definition(s) for symbol at ${filePath}:${line}:${character}:\n${formatted}`,
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      error: `LSP definition lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function execLspReferences(
  workspace: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const filePath = input.path as string;
  const line = input.line as number;
  const character = input.character as number;

  if (!filePath)
    return { success: false, output: "", error: "Missing required parameter: path" };
  if (typeof line !== "number" || line < 1)
    return { success: false, output: "", error: "line must be >= 1" };
  if (typeof character !== "number" || character < 1)
    return { success: false, output: "", error: "character must be >= 1" };

  const language = detectLanguage(filePath);
  if (!language)
    return {
      success: false,
      output: "",
      error: `No LSP support for file type: ${path.extname(filePath)}`,
    };

  const absPath = resolveSafePath(workspace, filePath);
  if (!fs.existsSync(absPath))
    return { success: false, output: "", error: `File not found: ${filePath}` };

  try {
    const server = await getOrCreateServer(workspace, language);
    const position: LspPosition = {
      line: line - 1,
      character: character - 1,
    };
    const locations = await server.references(absPath, position);

    if (locations.length === 0) {
      return {
        success: true,
        output: `No references found at ${filePath}:${line}:${character}`,
      };
    }

    const formatted = locations
      .map((loc) => formatLocation(loc, workspace))
      .join("\n");
    return {
      success: true,
      output: `${locations.length} reference(s) for symbol at ${filePath}:${line}:${character}:\n${formatted}`,
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      error: `LSP references lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function execLspDocumentSymbols(
  workspace: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const filePath = input.path as string;
  if (!filePath)
    return { success: false, output: "", error: "Missing required parameter: path" };

  const language = detectLanguage(filePath);
  if (!language)
    return {
      success: false,
      output: "",
      error: `No LSP support for file type: ${path.extname(filePath)}`,
    };

  const absPath = resolveSafePath(workspace, filePath);
  if (!fs.existsSync(absPath))
    return { success: false, output: "", error: `File not found: ${filePath}` };

  try {
    const server = await getOrCreateServer(workspace, language);
    const symbols = await server.documentSymbols(absPath);

    if (symbols.length === 0) {
      return {
        success: true,
        output: `No symbols found in ${filePath}`,
      };
    }

    const formatted = symbols.map((s) => formatSymbol(s)).join("\n");
    return {
      success: true,
      output: `Symbols in ${filePath} (${symbols.length} top-level):\n\n${formatted}`,
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      error: `LSP symbols lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function execLspDiagnostics(
  workspace: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const filePath = input.path as string;
  if (!filePath)
    return { success: false, output: "", error: "Missing required parameter: path" };

  const language = detectLanguage(filePath);
  if (!language)
    return {
      success: false,
      output: "",
      error: `No LSP support for file type: ${path.extname(filePath)}`,
    };

  const absPath = resolveSafePath(workspace, filePath);
  if (!fs.existsSync(absPath))
    return { success: false, output: "", error: `File not found: ${filePath}` };

  try {
    const server = await getOrCreateServer(workspace, language);
    const diagnostics = await server.getDiagnostics(absPath);

    if (diagnostics.length === 0) {
      return {
        success: true,
        output: `No diagnostics (errors/warnings) in ${filePath}`,
      };
    }

    const relPath = path.relative(workspace, absPath);
    const formatted = diagnostics
      .map((d) => {
        const line = d.range.start.line + 1;
        const char = d.range.start.character + 1;
        const sev = severityName(d.severity);
        const source = d.source ? ` [${d.source}]` : "";
        const code = d.code !== undefined ? ` (${d.code})` : "";
        return `${relPath}:${line}:${char} ${sev}${source}${code}: ${d.message}`;
      })
      .join("\n");

    const errorCount = diagnostics.filter((d) => d.severity === 1).length;
    const warnCount = diagnostics.filter((d) => d.severity === 2).length;
    const summary = `${diagnostics.length} diagnostic(s) in ${filePath} (${errorCount} errors, ${warnCount} warnings)`;

    return { success: true, output: `${summary}:\n\n${formatted}` };
  } catch (err) {
    return {
      success: false,
      output: "",
      error: `LSP diagnostics failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
