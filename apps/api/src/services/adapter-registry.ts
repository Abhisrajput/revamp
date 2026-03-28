/**
 * Adapter Registry — pluggable runtime interfaces for heterogeneous tools.
 *
 * Legacy modernization requires integrating with many different external tools:
 *   - Static analysis (SonarQube, Checkmarx, PMD, FindBugs)
 *   - Code conversion (JCLMIG, NACA, Micro Focus, SoftwareMining)
 *   - Testing (JUnit, pytest, Gherkin runners, SpecFlow)
 *   - Documentation (Confluence, SharePoint, Notion)
 *   - Source control (Git, PVCS, ClearCase, TFS)
 *   - Build systems (Ant, Maven, Gradle, MSBuild, Make)
 *
 * The adapter registry provides a uniform interface for pipeline stages
 * to discover and invoke these tools without hard coupling to any specific
 * implementation.
 *
 * Inspired by Paperclip's plugin adapter pattern and OpenViking's
 * heterogeneous tool integration approach.
 */

// ─── ADAPTER INTERFACE ──────────────────────────────────────────

export type AdapterCategory =
  | "static_analysis"
  | "code_conversion"
  | "testing"
  | "documentation"
  | "source_control"
  | "build_system"
  | "deployment"
  | "monitoring"
  | "database"
  | "custom";

export interface AdapterCapability {
  /** Unique capability identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this capability does */
  description: string;
  /** Input parameters schema (JSON Schema subset) */
  inputSchema: Record<string, unknown>;
  /** Output format description */
  outputFormat: string;
}

export interface ToolAdapter {
  /** Unique adapter identifier */
  id: string;
  /** Display name */
  name: string;
  /** Tool description */
  description: string;
  /** Category for discovery */
  category: AdapterCategory;
  /** Version string */
  version: string;
  /** Capabilities this adapter provides */
  capabilities: AdapterCapability[];
  /** Whether this adapter is currently available/configured */
  available: boolean;
  /** Check if the adapter can be used (e.g., binary exists, API key set) */
  healthCheck(): Promise<AdapterHealthResult>;
  /** Execute a capability */
  execute(capabilityId: string, input: Record<string, unknown>): Promise<AdapterResult>;
}

export interface AdapterHealthResult {
  healthy: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface AdapterResult {
  success: boolean;
  output: unknown;
  /** Structured data that can be injected into pipeline context */
  contextData?: string;
  /** Errors or warnings */
  messages: Array<{ level: "info" | "warn" | "error"; text: string }>;
  /** Execution metadata */
  meta: {
    durationMs: number;
    capabilityId: string;
    adapterId: string;
  };
}

// ─── REGISTRY ───────────────────────────────────────────────────

class AdapterRegistry {
  private adapters = new Map<string, ToolAdapter>();
  private categoryIndex = new Map<AdapterCategory, Set<string>>();

  /**
   * Register a tool adapter.
   */
  register(adapter: ToolAdapter): void {
    this.adapters.set(adapter.id, adapter);

    // Update category index
    if (!this.categoryIndex.has(adapter.category)) {
      this.categoryIndex.set(adapter.category, new Set());
    }
    this.categoryIndex.get(adapter.category)!.add(adapter.id);
  }

  /**
   * Unregister a tool adapter.
   */
  unregister(adapterId: string): boolean {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return false;

    this.adapters.delete(adapterId);
    this.categoryIndex.get(adapter.category)?.delete(adapterId);
    return true;
  }

  /**
   * Get an adapter by ID.
   */
  get(adapterId: string): ToolAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  /**
   * List all registered adapters.
   */
  list(): ToolAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * List adapters by category.
   */
  listByCategory(category: AdapterCategory): ToolAdapter[] {
    const ids = this.categoryIndex.get(category);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.adapters.get(id)!)
      .filter(Boolean);
  }

  /**
   * Find adapters that provide a specific capability.
   */
  findByCapability(capabilityId: string): ToolAdapter[] {
    return Array.from(this.adapters.values()).filter((adapter) =>
      adapter.capabilities.some((cap) => cap.id === capabilityId),
    );
  }

  /**
   * Execute a capability on the best available adapter.
   * Tries adapters in order: first available + healthy wins.
   */
  async execute(
    capabilityId: string,
    input: Record<string, unknown>,
  ): Promise<AdapterResult> {
    const adapters = this.findByCapability(capabilityId);
    if (adapters.length === 0) {
      return {
        success: false,
        output: null,
        messages: [{ level: "error", text: `No adapter found for capability: ${capabilityId}` }],
        meta: { durationMs: 0, capabilityId, adapterId: "none" },
      };
    }

    // Try each adapter until one succeeds
    const errors: string[] = [];
    for (const adapter of adapters) {
      if (!adapter.available) {
        errors.push(`${adapter.id}: not available`);
        continue;
      }

      try {
        const health = await adapter.healthCheck();
        if (!health.healthy) {
          errors.push(`${adapter.id}: unhealthy — ${health.message}`);
          continue;
        }

        return await adapter.execute(capabilityId, input);
      } catch (err) {
        errors.push(`${adapter.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      success: false,
      output: null,
      messages: errors.map((e) => ({ level: "error" as const, text: e })),
      meta: { durationMs: 0, capabilityId, adapterId: "none" },
    };
  }

  /**
   * Run health checks on all registered adapters.
   */
  async healthCheckAll(): Promise<Map<string, AdapterHealthResult>> {
    const results = new Map<string, AdapterHealthResult>();

    const checks = Array.from(this.adapters.entries()).map(async ([id, adapter]) => {
      try {
        const result = await adapter.healthCheck();
        results.set(id, result);
      } catch (err) {
        results.set(id, {
          healthy: false,
          message: `Health check threw: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    await Promise.allSettled(checks);
    return results;
  }

  /**
   * Get a summary of registered adapters for pipeline context injection.
   */
  getSummary(): string {
    const categories = new Map<AdapterCategory, ToolAdapter[]>();
    for (const adapter of this.adapters.values()) {
      if (!categories.has(adapter.category)) {
        categories.set(adapter.category, []);
      }
      categories.get(adapter.category)!.push(adapter);
    }

    const lines: string[] = ["## Available Tool Adapters\n"];
    for (const [category, adapters] of categories) {
      lines.push(`### ${category}`);
      for (const adapter of adapters) {
        const status = adapter.available ? "available" : "unavailable";
        lines.push(`- **${adapter.name}** (${status}): ${adapter.description}`);
        for (const cap of adapter.capabilities) {
          lines.push(`  - ${cap.name}: ${cap.description}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Clear all adapters. Used in testing.
   */
  reset(): void {
    this.adapters.clear();
    this.categoryIndex.clear();
  }
}

// ─── SINGLETON ──────────────────────────────────────────────────

export const adapterRegistry = new AdapterRegistry();

// ─── BUILT-IN ADAPTERS ──────────────────────────────────────────

/**
 * Git adapter — wraps git commands for source analysis.
 */
const gitAdapter: ToolAdapter = {
  id: "git-source-control",
  name: "Git",
  description: "Git version control integration for commit history, blame, and diff analysis.",
  category: "source_control",
  version: "1.0.0",
  capabilities: [
    {
      id: "git.log",
      name: "Commit History",
      description: "Retrieve commit log for a file or directory",
      inputSchema: { path: { type: "string" }, limit: { type: "number", default: 50 } },
      outputFormat: "JSON array of { hash, author, date, message }",
    },
    {
      id: "git.blame",
      name: "Line Blame",
      description: "Get blame information for a file",
      inputSchema: { path: { type: "string" } },
      outputFormat: "JSON array of { line, hash, author, date }",
    },
    {
      id: "git.diff",
      name: "Diff",
      description: "Get diff between two refs",
      inputSchema: { from: { type: "string" }, to: { type: "string" }, path: { type: "string" } },
      outputFormat: "Unified diff text",
    },
    {
      id: "git.file_history",
      name: "File Change Frequency",
      description: "Analyze change frequency of files to identify hotspots",
      inputSchema: { path: { type: "string" }, since: { type: "string" } },
      outputFormat: "JSON array of { path, changes, lastModified }",
    },
  ],
  available: true,
  async healthCheck() {
    try {
      const { execSync } = await import("child_process");
      execSync("git --version", { stdio: "pipe" });
      return { healthy: true, message: "git is available" };
    } catch {
      return { healthy: false, message: "git binary not found" };
    }
  },
  async execute(capabilityId, input) {
    const start = Date.now();
    const { execSync } = await import("child_process");
    const cwd = (input.cwd as string) || process.cwd();

    try {
      let output: string;

      switch (capabilityId) {
        case "git.log": {
          const limit = (input.limit as number) || 50;
          const path = (input.path as string) || ".";
          output = execSync(
            `git log --format='{"hash":"%H","author":"%an","date":"%aI","message":"%s"}' -n ${limit} -- "${path}"`,
            { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          );
          break;
        }
        case "git.blame": {
          const path = input.path as string;
          if (!path) throw new Error("path is required for git.blame");
          output = execSync(`git blame --porcelain "${path}"`, {
            cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
          });
          break;
        }
        case "git.diff": {
          const from = (input.from as string) || "HEAD~1";
          const to = (input.to as string) || "HEAD";
          const path = input.path as string;
          const pathArg = path ? `-- "${path}"` : "";
          output = execSync(`git diff ${from} ${to} ${pathArg}`, {
            cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
          });
          break;
        }
        case "git.file_history": {
          const since = (input.since as string) || "6 months ago";
          const path = (input.path as string) || ".";
          output = execSync(
            `git log --since="${since}" --name-only --pretty=format: -- "${path}" | sort | uniq -c | sort -rn | head -50`,
            { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          );
          break;
        }
        default:
          throw new Error(`Unknown capability: ${capabilityId}`);
      }

      return {
        success: true,
        output: output.trim(),
        contextData: output.trim().slice(0, 5000),
        messages: [],
        meta: { durationMs: Date.now() - start, capabilityId, adapterId: "git-source-control" },
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        messages: [{ level: "error", text: err instanceof Error ? err.message : String(err) }],
        meta: { durationMs: Date.now() - start, capabilityId, adapterId: "git-source-control" },
      };
    }
  },
};

/**
 * File system adapter — basic file analysis capabilities.
 */
const fsAdapter: ToolAdapter = {
  id: "fs-analyzer",
  name: "File System Analyzer",
  description: "File system analysis for directory structure, file counts, and size metrics.",
  category: "static_analysis",
  version: "1.0.0",
  capabilities: [
    {
      id: "fs.tree",
      name: "Directory Tree",
      description: "Generate a directory tree structure",
      inputSchema: { path: { type: "string" }, maxDepth: { type: "number", default: 4 } },
      outputFormat: "Text tree representation",
    },
    {
      id: "fs.stats",
      name: "File Statistics",
      description: "Count files by extension and calculate size metrics",
      inputSchema: { path: { type: "string" } },
      outputFormat: "JSON with extension counts and total sizes",
    },
    {
      id: "fs.large_files",
      name: "Large Files",
      description: "Find the largest files in a directory",
      inputSchema: { path: { type: "string" }, limit: { type: "number", default: 20 } },
      outputFormat: "JSON array of { path, size }",
    },
  ],
  available: true,
  async healthCheck() {
    return { healthy: true, message: "File system is always available" };
  },
  async execute(capabilityId, input) {
    const start = Date.now();
    const { execSync } = await import("child_process");
    const path = (input.path as string) || process.cwd();

    try {
      let output: string;

      switch (capabilityId) {
        case "fs.tree": {
          const maxDepth = (input.maxDepth as number) || 4;
          output = execSync(
            `find "${path}" -maxdepth ${maxDepth} -not -path '*/node_modules/*' -not -path '*/.git/*' | head -500`,
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          );
          break;
        }
        case "fs.stats": {
          output = execSync(
            `find "${path}" -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | sed 's/.*\\.//' | sort | uniq -c | sort -rn | head -30`,
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          );
          break;
        }
        case "fs.large_files": {
          const limit = (input.limit as number) || 20;
          output = execSync(
            `find "${path}" -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -exec ls -la {} \\; | sort -k5 -rn | head -${limit}`,
            { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          );
          break;
        }
        default:
          throw new Error(`Unknown capability: ${capabilityId}`);
      }

      return {
        success: true,
        output: output.trim(),
        contextData: output.trim().slice(0, 5000),
        messages: [],
        meta: { durationMs: Date.now() - start, capabilityId, adapterId: "fs-analyzer" },
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        messages: [{ level: "error", text: err instanceof Error ? err.message : String(err) }],
        meta: { durationMs: Date.now() - start, capabilityId, adapterId: "fs-analyzer" },
      };
    }
  },
};

// ─── AUTO-REGISTER BUILT-INS ────────────────────────────────────

adapterRegistry.register(gitAdapter);
adapterRegistry.register(fsAdapter);
