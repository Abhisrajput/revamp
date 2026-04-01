/**
 * BREE Engine Client — calls the standalone Rust BREE Engine service.
 *
 * The BREE Engine runs at BREE_ENGINE_URL (default: http://localhost:8081)
 * and provides language detection, parsing, and analysis for legacy codebases.
 *
 * Used by the SCAN stage to detect languages before intent extraction,
 * and by the DECODE stage to get parsed AST + dependency data.
 */

const BREE_URL = process.env.BREE_ENGINE_URL || "http://localhost:8081";
const TIMEOUT_MS = 30_000;
const ANALYSIS_TIMEOUT_MS = 120_000; // Deep analysis can take longer

// ─── Types ──────────────────────────────────────────────────────

export interface BreeHealthResponse {
  status: string;
  service: string;
  version: string;
}

export interface BreeLanguage {
  id: string;
  display_name: string;
  tier: string;
  family: string;
  parser_status: string;
  where_it_lives: string;
}

export interface BreeTier {
  tier: string;
  build_months: string;
  language_count: number;
  languages: string[];
}

export interface BreeDetectedLanguage {
  language_id: string;
  display_name: string;
  file_count: number;
  total_lines: number;
  total_bytes: number;
  confidence: number;
  detection_method: string;
  sample_files: string[];
}

export interface BreeLanguageProfile {
  primary: BreeDetectedLanguage[];
  secondary: BreeDetectedLanguage[];
  db_languages: BreeDetectedLanguage[];
  job_control: BreeDetectedLanguage[];
  polyglot_boundaries: unknown[];
  confidence_scores: Record<string, number>;
  unclassified_files: string[];
  stats: {
    total_files: number;
    classified_files: number;
    unclassified_files: number;
    languages_found: number;
    total_lines: number;
  };
}

export interface BreeParseResult {
  source_path: string;
  language_id: string;
  dialect: string;
  total_lines: number;
  symbols: number;
  ast_nodes: number;
  embedded_blocks: number;
  metadata: Record<string, unknown>;
  error?: string;
}

export interface BreeAnalysisReport {
  summary: {
    total_files: number;
    total_lines: number;
    languages_detected: number;
    parsers_used: number;
    files_parsed: number;
    embedded_blocks_found: number;
    cross_language_calls: number;
    copybooks_referenced: number;
    program_calls: number;
  };
  detection: { profile: BreeLanguageProfile };
  parse_results: Array<{
    source_path: string;
    language_id: string;
    dialect: string;
    total_lines: number;
    symbols_count: number;
    ast_nodes_count: number;
    embedded_blocks_count: number;
    metadata: Record<string, unknown>;
  }>;
  dependencies: Array<{
    from_module: string;
    to_module: string;
    dependency_type: unknown;
    reference_text: string;
  }>;
  polyglot_boundaries: Array<{
    from_file: string;
    from_language: string;
    to_target: string;
    to_language: string;
    mechanism: string;
    line: number;
  }>;
  priority_scores: Array<{
    language_id: string;
    display_name: string;
    tier: string;
    weighted_score: number;
    rank: number;
  }>;
  llm_strategy: {
    families_detected: Array<{
      family: string;
      languages_in_project: string[];
      system_prompt: string;
      prompt_focus: string;
    }>;
    recommendation: string;
  };
  warnings: string[];
}

export interface BreeScanResult {
  scan_summary: {
    root_path: string;
    total_files_found: number;
    files_included: number;
    files_skipped_binary: number;
    total_lines: number;
    total_bytes: number;
  };
  language_profile: BreeLanguageProfile;
}

// ─── Client ──────────────────────────────────────────────────────

async function breeRequest<T>(path: string, options?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const controller = new AbortController();
  const ms = options?.timeoutMs ?? TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), ms);

  try {
    const res = await fetch(`${BREE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`BREE Engine returned ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

/** Check if BREE Engine is reachable. */
export async function breeHealth(): Promise<BreeHealthResponse | null> {
  try {
    return await breeRequest<BreeHealthResponse>("/health");
  } catch {
    return null;
  }
}

/** Check if BREE Engine is online. */
export async function isBreeOnline(): Promise<boolean> {
  const health = await breeHealth();
  return health?.status === "ok";
}

/** List all supported languages with tier info. */
export async function breeListLanguages(): Promise<{ languages: BreeLanguage[]; total: number }> {
  return breeRequest("/api/v1/languages");
}

/** Get tier definitions. */
export async function breeListTiers(): Promise<{ tiers: BreeTier[] }> {
  return breeRequest("/api/v1/tiers");
}

/** Detect languages in uploaded source files. */
export async function breeDetect(
  files: Array<{ path: string; content: string }>,
): Promise<BreeLanguageProfile> {
  return breeRequest("/api/v1/detect", {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

/** Parse source files with registered parsers. */
export async function breeParse(
  files: Array<{ path: string; content: string }>,
): Promise<BreeParseResult[]> {
  return breeRequest("/api/v1/parse", {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

/** Scan a directory on the server filesystem. */
export async function breeScanDirectory(path: string): Promise<BreeScanResult> {
  return breeRequest("/api/v1/scan", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/** Run full analysis pipeline on inline files. */
export async function breeAnalyze(
  files: Array<{ path: string; content: string }>,
): Promise<BreeAnalysisReport> {
  return breeRequest("/api/v1/analyze", {
    method: "POST",
    body: JSON.stringify({ files }),
    timeoutMs: ANALYSIS_TIMEOUT_MS,
  });
}

/** Run full analysis pipeline on a directory path. */
export async function breeAnalyzeDirectory(path: string): Promise<BreeAnalysisReport> {
  return breeRequest("/api/v1/analyze", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/** Run full analysis and get markdown report. */
export async function breeAnalyzeReport(
  files: Array<{ path: string; content: string }>,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);
  try {
    const res = await fetch(`${BREE_URL}/api/v1/analyze/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
      signal: controller.signal,
    });
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

/** Get LLM prompt strategy for detected languages. */
export async function breeLlmStrategy(
  files: Array<{ path: string; content: string }>,
): Promise<{ families_detected: unknown[]; recommendation: string }> {
  return breeRequest("/api/v1/llm/prompt-strategy", {
    method: "POST",
    body: JSON.stringify({ files }),
  });
}

/** Get parser readiness matrix. */
export async function breeReadiness(): Promise<{
  entries: unknown[];
  overall_coverage: number;
  languages_with_parser: number;
  languages_without_parser: number;
}> {
  return breeRequest("/api/v1/readiness");
}

// ─── New Endpoints: Requirements, Graph, Full Context ───────────

export interface BreeRequirementsDoc {
  program_id: string;
  program_description: string;
  functional_requirements: Array<{
    id: string;
    name: string;
    paragraph: string;
    source_lines: [number, number];
    description: string;
    inputs: string[];
    outputs: string[];
    rules: Array<{ condition_raw: string; description: string; actions: string[] }>;
    calculations: Array<{ target: string; formula_raw: string; description: string; hardcoded: string[] }>;
    error_handling: string[];
    calls: string[];
  }>;
  data_dictionary: Array<{
    name: string; level: string; pic: string; description: string;
    values: string[]; group_parent: string | null;
  }>;
  integration_points: {
    database_tables: Array<{ table: string; operation: string; fields: string[] }>;
    external_programs: string[];
    cics_maps: string[];
    copybooks: string[];
    files: string[];
  };
  hardcoded_values: Array<{ value: string; meaning: string; risk: string; recommendation: string }>;
  process_flow: Array<{ sequence: number; paragraph: string; is_conditional: boolean }>;
  summary: {
    total_requirements: number; total_rules: number; total_calculations: number;
    total_integrations: number; total_data_fields: number; hardcoded_count: number;
    complexity_rating: string;
  };
}

export interface BreeGraphAnalysis {
  dead_code: { unreachable_paragraphs: unknown[]; unused_variables: unknown[]; dead_code_pct: number; total_lines: number };
  complexity: { functions: Array<{ name: string; complexity: number; risk: string }>; average_complexity: number; max_complexity: number };
  call_graph: { nodes: unknown[]; edges: unknown[]; mermaid: string; stats: { total_nodes: number; total_edges: number } };
  data_lineage: { total_fields: number; read_write: number; write_only: number; read_only: number };
  business_rules: { rules: Array<{ id: string; rule_type: string; description: string; confidence: number; hardcoded_values?: unknown[] }>; total_rules: number };
}

/** Unified BREE context for pipeline injection. */
export interface BreeFullContext {
  online: boolean;
  scanResult?: BreeScanResult;
  requirements?: { documents: BreeRequirementsDoc[]; total_files: number };
  graphAnalysis?: BreeGraphAnalysis;
  analysisReport?: BreeAnalysisReport;
  llmStrategy?: { families_detected: unknown[]; recommendation: string };
}

/** Generate requirements documents from code. */
export async function breeAnalyzeRequirements(
  input: { path?: string; files?: Array<{ path: string; content: string }> },
): Promise<{ documents: BreeRequirementsDoc[]; total_files: number }> {
  return breeRequest("/api/v1/analyze/requirements", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: ANALYSIS_TIMEOUT_MS,
  });
}

/** Deep analysis: dead code, complexity, call graph, data lineage, business rules. */
export async function breeAnalyzeGraph(
  input: { path?: string; files?: Array<{ path: string; content: string }> },
): Promise<BreeGraphAnalysis> {
  return breeRequest("/api/v1/analyze/graph", {
    method: "POST",
    body: JSON.stringify(input),
    timeoutMs: ANALYSIS_TIMEOUT_MS,
  });
}

/** Get full BREE context for pipeline stage injection. Non-fatal — returns partial data on errors. */
export async function breeFullContext(
  input: { path?: string; files?: Array<{ path: string; content: string }> },
): Promise<BreeFullContext> {
  const online = await isBreeOnline();
  if (!online) return { online: false };

  const results: BreeFullContext = { online: true };

  // Run all analyses in parallel — each is independent and non-fatal
  const promises = [
    input.path
      ? breeScanDirectory(input.path).then(r => { results.scanResult = r; }).catch(() => {})
      : Promise.resolve(),
    breeAnalyzeRequirements(input).then(r => { results.requirements = r; }).catch(() => {}),
    breeAnalyzeGraph(input).then(r => { results.graphAnalysis = r; }).catch(() => {}),
    input.path
      ? breeAnalyzeDirectory(input.path).then(r => { results.analysisReport = r; }).catch(() => {})
      : input.files
        ? breeAnalyze(input.files).then(r => { results.analysisReport = r; }).catch(() => {})
        : Promise.resolve(),
  ];

  await Promise.all(promises);
  return results;
}

/**
 * Format BREE context as a text block for LLM prompt injection.
 * This is the key function — it converts BREE's structured JSON into
 * a concise, LLM-readable context section.
 */
export function formatBreeContextForPrompt(ctx: BreeFullContext, maxTokens = 8000): string {
  if (!ctx.online) return "";

  const sections: string[] = [];

  // Language detection
  if (ctx.scanResult?.language_profile) {
    const lp = ctx.scanResult.language_profile;
    const langs = [...lp.primary, ...lp.secondary].map(l => `${l.language_id} (${l.file_count} files, ${l.total_lines} lines)`);
    sections.push(`**Languages Detected**: ${langs.join(", ")}`);
  }

  // Requirements summary
  if (ctx.requirements?.documents?.length) {
    for (const doc of ctx.requirements.documents) {
      sections.push(`\n**Program: ${doc.program_id}** — ${doc.program_description}`);

      // Process flow
      if (doc.process_flow.length > 0) {
        sections.push(`Process Flow: ${doc.process_flow.map(s => s.paragraph).join(" → ")}`);
      }

      // Functional requirements (compact)
      for (const fr of doc.functional_requirements) {
        let line = `- ${fr.id} ${fr.name}: ${fr.description}`;
        for (const r of fr.rules) {
          line += `\n  Rule: ${r.description}`;
        }
        for (const c of fr.calculations) {
          line += `\n  Calc: ${c.description}`;
          if (c.hardcoded.length > 0) line += ` ⚠ hardcoded: ${c.hardcoded.join(", ")}`;
        }
        sections.push(line);
      }

      // Data dictionary (compact)
      if (doc.data_dictionary.length > 0) {
        const fields = doc.data_dictionary.slice(0, 20).map(f => {
          let s = `${f.name} (${f.pic || "group"})`;
          if (f.values.length > 0) s += ` [${f.values.join(", ")}]`;
          return s;
        });
        sections.push(`\n**Data Dictionary**: ${fields.join(", ")}`);
      }

      // Integration points
      const ip = doc.integration_points;
      const ints = [
        ...ip.database_tables.map(d => `DB:${d.operation} ${d.table}`),
        ...ip.external_programs.map(p => `CALL:${p}`),
        ...ip.cics_maps.map(m => `CICS:${m}`),
        ...ip.copybooks.map(c => `COPY:${c}`),
      ];
      if (ints.length > 0) {
        sections.push(`**Integrations**: ${ints.join(", ")}`);
      }

      // Hardcoded values
      if (doc.hardcoded_values.length > 0) {
        sections.push(`**⚠ Hardcoded Values**: ${doc.hardcoded_values.map(h => `${h.value} (${h.meaning})`).join(", ")}`);
      }
    }
  }

  // Complexity metrics
  if (ctx.graphAnalysis?.complexity) {
    const cx = ctx.graphAnalysis.complexity;
    const high = cx.functions.filter(f => f.risk === "high" || f.risk === "critical");
    sections.push(`\n**Complexity**: avg=${cx.average_complexity.toFixed(1)}, max=${cx.max_complexity}${high.length > 0 ? `, HIGH RISK: ${high.map(f => f.name).join(", ")}` : ""}`);
  }

  // Dead code
  if (ctx.graphAnalysis?.dead_code) {
    const dc = ctx.graphAnalysis.dead_code;
    if (dc.unreachable_paragraphs.length > 0 || dc.dead_code_pct > 0.05) {
      sections.push(`**Dead Code**: ${(dc.dead_code_pct * 100).toFixed(0)}% dead, ${dc.unreachable_paragraphs.length} unreachable paragraphs`);
    }
  }

  // Business rules summary
  if (ctx.graphAnalysis?.business_rules) {
    const br = ctx.graphAnalysis.business_rules;
    sections.push(`**Business Rules**: ${br.total_rules} extracted (${br.rules.filter(r => r.confidence >= 0.9).length} high-confidence)`);
  }

  let result = sections.join("\n");

  // Rough truncation to stay within token budget (1 token ≈ 4 chars)
  const maxChars = maxTokens * 4;
  if (result.length > maxChars) {
    result = result.substring(0, maxChars) + "\n... (truncated)";
  }

  return result;
}

/** Convenience: get a summary object for injecting into SCAN stage context. */
export async function breeScanContext(
  files: Array<{ path: string; content: string }>,
): Promise<{
  online: boolean;
  languageProfile: BreeLanguageProfile | null;
  llmStrategy: { recommendation: string } | null;
}> {
  const online = await isBreeOnline();
  if (!online) {
    return { online: false, languageProfile: null, llmStrategy: null };
  }

  try {
    const [profile, strategy] = await Promise.all([
      breeDetect(files),
      breeLlmStrategy(files),
    ]);
    return { online: true, languageProfile: profile, llmStrategy: strategy };
  } catch {
    return { online: true, languageProfile: null, llmStrategy: null };
  }
}
